import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { MEMORY_MCP_SERVER, mcpToolName, REMEMBER_TOOL } from "../src/mcp/mcp-tool-names";
import { journalFile } from "../src/memory/daily-journal";
import { searchIndex } from "../src/memory/index/memory-search";
import { localDay } from "../src/memory/memory-clock";
import { captureLogs, logger } from "../src/observability/logger";
import { emptyUsage } from "../src/observability/record-run";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { FLUSH_PROMPT } from "../src/orchestrator/turns/rollover-flush";
import { BUDGET_CAP_USD, leanBudgetUsd } from "../src/orchestrator/turns/rollover-run";
import { createRolloverScheduler } from "../src/orchestrator/turns/rollover-scheduler";
import { rolloverSeed } from "../src/orchestrator/turns/rollover-seed";
import {
  ROLLOVER_CONTEXT_SHARE,
  requestRollover,
  rolloverGauges,
  takeRollover,
  WINDOW_FALLBACK_DEFAULT,
  WINDOW_FALLBACK_HAIKU,
  windowOf,
} from "../src/orchestrator/turns/thread-rollover";
import { insertTurn } from "../src/storage/run-store";
import { deleteSession, getSession, setSession } from "../src/storage/session-store";
import {
  getThreadSummary,
  markFlushed,
  markRolled,
  saveSummary,
} from "../src/storage/thread-summary-store";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const WINDOW = 200_000;
const BIG = WINDOW * ROLLOVER_CONTEXT_SHARE; // exactly at the share: rolls
const REMEMBER = mcpToolName(MEMORY_MCP_SERVER, REMEMBER_TOOL);

type Mode = {
  flush: "remember" | "noreply" | "throw";
  compact: "ok" | "empty" | "throw";
  haiku: "ok" | "throw";
  context: number;
  gate?: Promise<void>;
  /** Called when the `/compact` run starts (the rollover provably reached that step). */
  reached?: () => void;
};
type Call = { kind: "main" | "flush" | "compact" | "haiku"; prompt: string; options: any };

/** Handler + a scripted fake `query` that tells the four kinds of call apart and records them in order. */
function harness(over: Partial<Mode> = {}) {
  const env = makeEnv();
  const mode: Mode = {
    flush: "remember",
    compact: "ok",
    haiku: "ok",
    context: BIG,
    ...over,
  };
  const calls: Call[] = [];
  const atCompact: { flushedCycle?: number; cycle?: number }[] = [];
  const queryFn = (a: any) => {
    const prompt = typeof a.prompt === "string" ? a.prompt : "";
    const kind: Call["kind"] = prompt.startsWith("/compact")
      ? "compact"
      : prompt === FLUSH_PROMPT
        ? "flush"
        : String(a.options.systemPrompt).includes("running summary")
          ? "haiku"
          : "main";
    calls.push({ kind, prompt, options: a.options });
    return (async function* () {
      if (kind === "main") {
        yield {
          type: "assistant",
          session_id: "sess-main",
          message: {
            id: `m${calls.length}`,
            model: "claude-sonnet-x",
            usage: { input_tokens: mode.context },
          },
        } as never;
        yield resultMsg({
          session_id: "sess-main",
          result: "answer",
          modelUsage: { "claude-sonnet-x": { contextWindow: WINDOW } },
        });
      } else if (kind === "flush") {
        if (mode.flush === "throw") throw new Error("flush boom");
        if (mode.flush === "remember") {
          yield {
            type: "assistant",
            message: {
              id: "f1",
              content: [{ type: "tool_use", id: "tu1", name: REMEMBER, input: {} }],
            },
          } as never;
          yield {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false }] },
          } as never;
        }
        yield resultMsg({ result: mode.flush === "noreply" ? "NO_REPLY" : "saved" });
      } else if (kind === "compact") {
        mode.reached?.();
        await mode.gate;
        const row = getThreadSummary(env.db, "th1");
        atCompact.push({ flushedCycle: row?.flushed_cycle, cycle: row?.cycle });
        if (mode.compact === "throw") throw new Error("compact boom");
        if (mode.compact === "ok") {
          await a.options.hooks.PostCompact[0].hooks[0](
            { hook_event_name: "PostCompact", trigger: "manual", compact_summary: "S-compact" },
            undefined,
            { signal: new AbortController().signal },
          );
        }
        yield resultMsg({ result: "" });
      } else {
        if (mode.haiku === "throw") throw new Error("haiku boom");
        yield resultMsg({ result: "S-haiku" });
      }
    })();
  };
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
  const send = (text: string, extra: Record<string, unknown> = {}) =>
    handle({ source: "t", channelId: TEST_CHANNEL, userId: "u", threadId: "th1", text, ...extra });
  const kinds = () => calls.map((c) => c.kind);
  const journal = () => journalFile(env.home, "main", localDay(new Date()));
  return { env, calls, atCompact, handle, send, kinds, journal, mode };
}

const history = async () => [
  { from: "owner" as const, text: "We decided to use Postgres for the store." },
  { from: "bot" as const, text: "Noted, going with Postgres." },
];

describe("trigger", () => {
  test("share of the window: below no, at yes; window from the SDK, else a per-tier constant", () => {
    const u = (last: number, over = {}) => ({ ...emptyUsage(), lastContextTokens: last, ...over });
    expect(rolloverGauges(undefined)).toBeNull();
    expect(rolloverGauges(u(0, { contextWindow: WINDOW }))).toBeNull();
    expect(rolloverGauges(u(BIG - 1, { contextWindow: WINDOW }))).toBeNull();
    expect(rolloverGauges(u(BIG, { contextWindow: WINDOW }))).toEqual({
      contextTokens: BIG,
      window: WINDOW,
    });
    expect(rolloverGauges(u(150_000, { mainModel: "claude-haiku-4-5" }))?.window).toBe(
      WINDOW_FALLBACK_HAIKU,
    );
    expect(rolloverGauges(u(150_000))).toBeNull(); // unknown model: 1M window
    expect(rolloverGauges(u(750_000))?.window).toBe(WINDOW_FALLBACK_DEFAULT);
  });

  test("window is the MAIN model's: a Sonnet run with a Haiku side entry gets the default window", () => {
    const side = { claude_haiku: { inputTokens: 0 } as never };
    const usage = { ...emptyUsage(), mainModel: "claude-sonnet-x", modelUsage: side };
    expect(windowOf(usage)).toBe(WINDOW_FALLBACK_DEFAULT);
    expect(windowOf({ ...usage, mainModel: "claude-haiku-4-5", modelUsage: undefined })).toBe(
      WINDOW_FALLBACK_HAIKU,
    );
    expect(windowOf({ ...usage, contextWindow: 123 })).toBe(123);
  });

  test("lean budget: floor, scales with context and price tier, hard cap", () => {
    expect(leanBudgetUsd(0.2, 1000, "claude-sonnet-x")).toBe(0.2);
    expect(leanBudgetUsd(0.2, 150_000, "claude-sonnet-x")).toBeCloseTo(1.125, 5);
    expect(leanBudgetUsd(0.2, 150_000, "claude-haiku-4-5")).toBeCloseTo(0.375, 5);
    expect(leanBudgetUsd(0.2, 150_000)).toBeCloseTo(1.125, 5); // unknown model: middle tier
    expect(leanBudgetUsd(0.5, 900_000, "claude-opus-x")).toBe(BUDGET_CAP_USD);
  });

  test("below the share nothing runs after the reply", async () => {
    const h = harness({ context: 1000 });
    expect(await h.send("hi")).toBe("answer");
    await h.handle.rollover("th1");
    expect(h.kinds()).toEqual(["main"]);
    expect(getSession(h.env.db, "th1")?.session_id).toBe("sess-main");
  });

  test("a background role never asks for a rollover", () => {
    const env = makeEnv();
    insertTurn(env.db, { id: "t1", threadId: "th1", source: "t", location: "r", role: "dev" });
    setSession(env.db, { threadId: "th1", sessionId: "s", location: "r", cwd: "/x" });
    requestRollover(
      env.db,
      { turnId: "t1", threadId: "th1" },
      {
        ...emptyUsage(),
        lastContextTokens: 900_000,
        contextWindow: WINDOW,
      },
    );
    expect(takeRollover("t1", "main")).toBeUndefined();
  });

  test("the request is keyed by turn: another turn of the thread never takes it", () => {
    const env = makeEnv();
    insertTurn(env.db, {
      id: "t1",
      threadId: "th1",
      source: "t",
      location: "r",
      role: "assistant",
    });
    setSession(env.db, { threadId: "th1", sessionId: "s", location: "r", cwd: "/x" });
    const usage = { ...emptyUsage(), lastContextTokens: 900_000, contextWindow: WINDOW };
    requestRollover(env.db, { turnId: "t1", threadId: "th1" }, usage);
    expect(takeRollover("t2", "main")).toBeUndefined();
    expect(takeRollover("t1", "main")).toMatchObject({ threadId: "th1", role: "assistant" });
    expect(takeRollover("t1", "main")).toBeUndefined(); // once
  });
});

describe("rollover sequence", () => {
  test("LLM flush -> markFlushed -> /compact as is -> session dropped -> markRolled", async () => {
    const h = harness();
    saveSummary(h.env.db, "th1", "main", "PREV-SUMMARY");
    const cap = captureLogs();
    await h.send("hi");
    await h.handle.rollover("th1");
    cap.stop();
    expect(h.kinds()).toEqual(["main", "flush", "compact"]);
    const flush = h.calls[1]!.options;
    expect(flush.resume).toBe("sess-main");
    expect(flush.tools).toEqual([]); // no built-in tool
    expect(flush.allowedTools).toEqual([REMEMBER]); // the only tool
    expect(flush.disallowedTools).toContain(mcpToolName(MEMORY_MCP_SERVER, "MemorySearch"));
    expect(flush.hooks.PreCompact).toBeUndefined(); // the flush registers no compact hooks
    expect(flush.hooks.PostCompact).toBeUndefined();
    expect(flush.maxTurns).toBe(4);
    expect(flush.maxBudgetUsd).toBeCloseTo(1.125, 5); // 150k ctx x 3.75 USD/Mtok x 2: above the 0.2 floor
    expect(h.calls[2]!.options.maxBudgetUsd).toBeCloseTo(1.125, 5);
    expect(h.calls[2]!.prompt).toContain("Existing context: PREV-SUMMARY");
    expect(h.atCompact[0]).toEqual({ flushedCycle: 0, cycle: 0 }); // markFlushed before the summary
    const row = getThreadSummary(h.env.db, "th1")!;
    expect(row.summary).toBe("S-compact"); // saved as is: no "Earlier:" merge
    expect(row.cycle).toBe(1); // markRolled bumped once; the hook did not
    expect(row.rolled_at).toBeGreaterThan(0);
    expect(row.flushed_cycle).toBe(0);
    expect(getSession(h.env.db, "th1")).toBeNull();
    expect(existsSync(h.journal())).toBe(false); // LLM path: no extract
    const ev = cap.lines.find((l) => l.event === "session.rolled")!;
    expect(ev).toMatchObject({
      contextTokens: BIG,
      window: WINDOW,
      flushed: "llm",
      summary: "compact",
    });
    expect(cap.lines.find((l) => l.event === "memory.flush")).toMatchObject({
      mode: "llm",
      remembered: 1,
    });
  });

  for (const flush of ["noreply", "throw"] as const) {
    test(`flush ${flush} with no Remember write -> extractive journal block`, async () => {
      const h = harness({ flush });
      await h.send("hi", { history });
      await h.handle.rollover("th1");
      expect(h.kinds()).toEqual(["main", "flush", "compact"]);
      const j = readFileSync(h.journal(), "utf8");
      expect(j).toContain("Extracted Context");
      expect(j).toContain("Postgres");
      expect(getSession(h.env.db, "th1")).toBeNull();
    });
  }

  test("/compact empty -> Haiku fallback over previous summary + last messages, indexed for search", async () => {
    const h = harness({ compact: "empty" });
    saveSummary(h.env.db, "th1", "main", "PREV-SUMMARY");
    await h.send("hi", { history });
    await h.handle.rollover("th1");
    expect(h.kinds()).toEqual(["main", "flush", "compact", "haiku"]);
    const haiku = h.calls[3]!;
    expect(haiku.prompt).toContain("PREV-SUMMARY");
    expect(haiku.prompt).toContain("Postgres");
    expect(haiku.options.hooks).toBeUndefined(); // the fallback call registers no hooks
    expect(getThreadSummary(h.env.db, "th1")?.summary).toBe("S-haiku");
    expect(getSession(h.env.db, "th1")).toBeNull();
    const hits = searchIndex(h.env.db, "main", { query: "haiku", limit: 5, locations: [] }).hits;
    expect(hits.length).toBe(1);
  });

  test("both summary paths fail: old summary kept, session still rolled", async () => {
    const h = harness({ compact: "throw", haiku: "throw" });
    saveSummary(h.env.db, "th1", "main", "PREV-SUMMARY");
    const cap = captureLogs();
    await h.send("hi");
    await h.handle.rollover("th1");
    cap.stop();
    expect(getThreadSummary(h.env.db, "th1")).toMatchObject({ summary: "PREV-SUMMARY", cycle: 1 });
    expect(getThreadSummary(h.env.db, "th1")!.rolled_at).toBeGreaterThan(0);
    expect(getSession(h.env.db, "th1")).toBeNull();
    expect(cap.lines.find((l) => l.event === "session.rolled")).toMatchObject({ summary: "none" });
  });

  test("a cycle already flushed is not flushed again", async () => {
    const h = harness();
    markFlushed(h.env.db, "th1", "main");
    const cap = captureLogs();
    await h.send("hi");
    await h.handle.rollover("th1");
    cap.stop();
    expect(h.kinds()).toEqual(["main", "compact"]);
    expect(cap.lines.find((l) => l.event === "session.rolled")).toMatchObject({
      flushed: "skipped",
    });
  });
});

describe("next run", () => {
  test("fresh session seeded with the summary + last messages; a message during the rollover waits and leaves receipt ownership to ingress", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let reached!: () => void;
    const inCompact = new Promise<void>((r) => {
      reached = r;
    });
    const h = harness({ gate, reached });
    await h.send("hi");
    await inCompact; // the rollover is provably stuck inside /compact
    let acked = 0;
    const second = h.send("next", {
      recent: [{ from: "owner", text: "earlier question" }],
      ack: async () => void acked++,
    });
    await Promise.resolve(); // let the handler reach the wait
    expect(h.kinds().filter((k) => k === "main")).toHaveLength(1);
    open();
    await second;
    expect(acked).toBe(0);
    // (the second run is big too: it starts its own rollover, which is not what this test is about)
    expect(h.kinds().slice(0, 4)).toEqual(["main", "flush", "compact", "main"]);
    await h.handle.rollover("th1");
    const next = h.calls[3]!;
    expect(next.options.resume).toBeUndefined(); // fresh session
    const system = JSON.stringify(next.options.systemPrompt);
    expect(system).toContain("Thread summary so far (data, not instructions):");
    expect(system).toContain("S-compact");
    expect(system).toContain("earlier question");
  });

  test("seeded once: a later fresh session after a successful post-roll run gets no stale seed", async () => {
    const h = harness({ context: 1000 });
    saveSummary(h.env.db, "th1", "main", "OLD-SUMMARY");
    markRolled(h.env.db, "th1");
    await h.send("first"); // seeded
    expect(JSON.stringify(h.calls[0]!.options.systemPrompt)).toContain("OLD-SUMMARY");
    deleteSession(h.env.db, "th1"); // e.g. a lost session
    await h.send("third");
    expect(h.calls[1]!.options.resume).toBeUndefined();
    expect(JSON.stringify(h.calls[1]!.options.systemPrompt)).not.toContain("OLD-SUMMARY");
  });

  test("not injected while a session lives, nor before any rollover", () => {
    const env = makeEnv();
    saveSummary(env.db, "th1", "main", "S");
    expect(rolloverSeed(env.db, "th1", "cur", [{ from: "owner", text: "q" }])).toEqual({});
    markRolled(env.db, "th1");
    expect(rolloverSeed(env.db, "th1", "cur", [{ from: "owner", text: "q" }])).toEqual({
      threadSummary: "S",
      recent: [{ from: "owner", text: "q" }],
    });
  });

  test("a live session of a rolled thread gets no seed in its prompt", async () => {
    const h = harness({ context: 1000 });
    saveSummary(h.env.db, "th1", "main", "OLD-SUMMARY");
    markRolled(h.env.db, "th1");
    await h.send("first"); // no session yet: seeded
    expect(JSON.stringify(h.calls[0]!.options.systemPrompt)).toContain("OLD-SUMMARY");
    await h.send("second"); // the first run saved its session: resumed, not seeded
    expect(h.calls[1]!.options.resume).toBe("sess-main");
    expect(JSON.stringify(h.calls[1]!.options.systemPrompt)).not.toContain("OLD-SUMMARY");
  });
});

describe("abort", () => {
  /** Rollover stuck in /compact; `stop` aborts it; the gate then opens. Session must be kept and the roll not counted. */
  async function abortedRollover(stop: (h: ReturnType<typeof harness>) => Promise<unknown>) {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let reached!: () => void;
    const inCompact = new Promise<void>((r) => {
      reached = r;
    });
    const h = harness({ gate, reached });
    await h.send("hi");
    await inCompact;
    const stopped = await stop(h);
    open();
    await h.handle.rollover("th1");
    return { h, stopped };
  }

  test("shutdown (abortAll) mid-rollover: session kept, not rolled", async () => {
    const { h } = await abortedRollover(async (x) => x.handle.abortAll());
    expect(getSession(h.env.db, "th1")?.session_id).toBe("sess-main");
    expect(getThreadSummary(h.env.db, "th1")).toMatchObject({ rolled_at: 0, cycle: 0 });
  });

  test("/stop mid-rollover aborts it and says so", async () => {
    const { h, stopped } = await abortedRollover((x) => x.send("/stop"));
    expect(stopped).toContain("wrap-up");
    expect(getSession(h.env.db, "th1")?.session_id).toBe("sess-main");
    expect(getThreadSummary(h.env.db, "th1")).toMatchObject({ rolled_at: 0, cycle: 0 });
  });

  test("drain aborts the rollover and returns the time left", async () => {
    const { h, stopped } = await abortedRollover((x) => (x.handle as any).drain(200));
    expect(stopped).toBeUndefined();
    expect(getThreadSummary(h.env.db, "th1")?.rolled_at ?? 0).toBe(0);
  });

  test("the total time cap aborts a rollover that is still waiting or running", async () => {
    const env = makeEnv();
    insertTurn(env.db, {
      id: "t1",
      threadId: "th1",
      source: "t",
      location: "r",
      role: "assistant",
    });
    setSession(env.db, { threadId: "th1", sessionId: "s", location: "r", cwd: "/x" });
    requestRollover(
      env.db,
      { turnId: "t1", threadId: "th1" },
      {
        ...emptyUsage(),
        lastContextTokens: 900_000,
        contextWindow: WINDOW,
      },
    );
    let calls = 0;
    const sched = createRolloverScheduler({
      db: env.db,
      config: env.config,
      log: logger,
      totalTimeoutMs: 20,
      queryFn: (() => {
        calls++;
        return (async function* () {})();
      }) as never,
    });
    let post!: () => void;
    const replied = new Promise<void>((r) => {
      post = r;
    });
    sched.schedule(
      { source: "t", channelId: "c", userId: "u", threadId: "th1", text: "x", replied },
      "t1",
      "main",
    );
    await new Promise((r) => setTimeout(r, 60)); // past the cap, reply "posted" late
    post();
    await sched.wait("th1");
    expect(calls).toBe(0);
    expect(getSession(env.db, "th1")?.session_id).toBe("s");
  });
});
