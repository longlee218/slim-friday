import { describe, expect, test } from "bun:test";
import { captureLogs, logger } from "../src/observability/logger";
import { contextWindowFor, mergeModelUsage } from "../src/observability/model-usage";
import {
  addUsage,
  avgContextTokens,
  emptyUsage,
  usageFromResult,
} from "../src/observability/record-run";
import { createRunGauges } from "../src/observability/run-gauges";
import { newSubagentLimit } from "../src/policy/subagent-limit";
import { getRole } from "../src/roles/role-registry";
import { guardHook } from "../src/runtime/guard-hook";
import { runAgent } from "../src/runtime/run-agent";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import { ASK_USER_QUESTION_TOOL_NAME, BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { fakeQuery, initMsg, makeEnv, resultMsg } from "./helpers";

/** Assistant message of one model call (usage as the SDK sends it). */
const asst = (id: string, input: number, cacheRead: number, extra: Record<string, unknown> = {}) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id,
      model: "claude-haiku-4-5",
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: 1 },
      content: [{ type: "text", text: "SECRET-BODY" }],
    },
    ...extra,
  }) as never;

const boundary = {
  type: "system",
  subtype: "compact_boundary",
  session_id: "sess-1",
  compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 20000 },
} as never;

/** A user message carrying tool_result blocks (flags: is_error per block). */
const toolResults = (...errs: boolean[]) =>
  ({
    type: "user",
    message: {
      content: errs.map((e, i) => ({
        type: "tool_result",
        tool_use_id: `t${i}`,
        is_error: e,
        content: "SECRET-OUTPUT",
      })),
    },
  }) as never;

function go(env: ReturnType<typeof makeEnv>, queryFn: ReturnType<typeof fakeQuery>) {
  return runAgent({
    prompt: "q",
    turnId: "T",
    role: getRole("lead"),
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn,
  });
}

describe("run metrics", () => {
  test("peak/last context, tool errors, compact.boundary and run.finished fields (no content)", async () => {
    const env = makeEnv();
    const cap = captureLogs();
    const r = await go(
      env,
      fakeQuery([
        initMsg,
        asst("m1", 10, 90), // ctx 100
        toolResults(true, false, true),
        asst("m2", 5, 5, { parent_tool_use_id: "tu", agent_id: "a1" }), // subagent: ignored by the gauges
        boundary,
        asst("m3", 20, 30), // ctx 50 (after compaction): last, below the peak
        resultMsg({
          modelUsage: { "claude-haiku-4-5": { contextWindow: 200000, costUSD: 0.01 } },
        }),
      ]),
    );
    cap.stop();
    expect(r.usage).toMatchObject({
      compactions: 1,
      peakContextTokens: 100,
      lastContextTokens: 50,
      toolErrors: 2,
      contextWindow: 200000,
    });
    const b = cap.lines.find((l) => l.event === "compact.boundary")!;
    expect(b).toMatchObject({ preTokens: 150000, postTokens: 20000, trigger: "auto" });
    const f = cap.lines.find((l) => l.event === "run.finished")!;
    expect(f).toMatchObject({
      compactions: 1,
      peakContextTokens: 100,
      lastContextTokens: 50,
      toolErrors: 2,
      maxTurnsHit: false,
      avgContextTokens: avgContextTokens(usageFromResult(resultMsg() as never, 0)),
    });
    expect(JSON.stringify(cap.lines)).not.toContain("SECRET-");
    // SQL insert unchanged: the run row still has the compaction count.
    const row = env.db.query("SELECT compactions FROM runs").get() as { compactions: number };
    expect(row.compactions).toBe(1);
  });

  test("max_turns result -> maxTurnsHit true", async () => {
    const env = makeEnv();
    const cap = captureLogs();
    await go(env, fakeQuery([initMsg, resultMsg({ subtype: "error_max_turns", errors: ["x"] })]));
    cap.stop();
    const f = cap.lines.find((l) => l.event === "run.finished")!;
    expect(f).toMatchObject({ outcome: "max_turns", maxTurnsHit: true });
  });

  test("addUsage: peak = max, last = later round (kept when it had none), errors summed", () => {
    const a = { ...emptyUsage(), peakContextTokens: 100, lastContextTokens: 80, toolErrors: 1 };
    const b = { ...emptyUsage(), peakContextTokens: 60, lastContextTokens: 0, toolErrors: 2 };
    const m = addUsage(a, b);
    expect(m).toMatchObject({ peakContextTokens: 100, lastContextTokens: 80, toolErrors: 3 });
    expect(addUsage(a, { ...b, lastContextTokens: 40, contextWindow: 1e6 })).toMatchObject({
      lastContextTokens: 40,
      contextWindow: 1e6,
    });
  });

  test("compact_boundary as the last message: last context = post_tokens", async () => {
    const env = makeEnv();
    const r = await go(env, fakeQuery([initMsg, asst("m1", 10, 90), boundary, resultMsg()]));
    expect(r.usage).toMatchObject({ peakContextTokens: 100, lastContextTokens: 20000 });
  });

  test("boundary without post_tokens keeps the earlier last context", () => {
    const g = createRunGauges(new Set());
    g.onTurn({ turn: 1, in: 70, cacheRead: 0, cacheCreate: 0, outApprox: 0, ctxTotal: 70 });
    g.onBoundary(undefined);
    g.onBoundary(0);
    expect(g.snapshot().lastContextTokens).toBe(70);
  });

  test("contextWindow: exact key, prefix either way, mismatch -> undefined", () => {
    const mu = { "claude-sonnet-5-5": { contextWindow: 1e6 } } as never;
    expect(contextWindowFor(mu, "claude-sonnet-5-5")).toBe(1e6);
    expect(contextWindowFor(mu, "claude-sonnet-5-5[1m]")).toBe(1e6);
    expect(
      contextWindowFor(
        { "claude-haiku-4-5-20251001": { contextWindow: 2e5 } } as never,
        "claude-haiku-4-5",
      ),
    ).toBe(2e5);
    expect(contextWindowFor(mu, "other-model")).toBeUndefined();
    expect(contextWindowFor(undefined, "x")).toBeUndefined();
  });

  test("mergeModelUsage keeps contextWindow (later wins, earlier kept when absent)", () => {
    const e = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheCreationTokens: 1,
      costUsd: 1,
    };
    const a = { m: { ...e, contextWindow: 200000 } };
    expect(mergeModelUsage(a, { m: { ...e } })?.m?.contextWindow).toBe(200000);
    expect(mergeModelUsage(a, { m: { ...e, contextWindow: 1e6 } })?.m?.contextWindow).toBe(1e6);
  });

  test("tool errors: main only, guard denials counted separately, subagent internals ignored", () => {
    const res = (id: string, err: boolean, extra: Record<string, unknown> = {}) => ({
      type: "user",
      ...extra,
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: err }] },
    });
    const g = createRunGauges(new Set(["d1"]));
    g.onUser(res("d1", true)); // denied by our guard
    g.onUser(res("d1", true)); // same id twice: once
    g.onUser(res("e1", true)); // real tool failure
    g.onUser(res("ok", false));
    g.onUser(res("s1", true, { parent_tool_use_id: "toolu_task" })); // subagent internal
    g.onUser(res("task", true)); // the Task echo of that failure, main level: counts once
    expect(g.snapshot()).toMatchObject({ toolErrors: 2, toolDenied: 1 });
  });

  test("guard deny and canUseTool deny report the tool_use_id", async () => {
    const seen: string[] = [];
    const p = { turnId: "T", threadId: "th", guard: {}, onDeny: (id: string) => seen.push(id) };
    const hook = guardHook(p, new Map(), logger, newSubagentLimit());
    await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: BASH_TOOL_NAME,
        tool_input: { command: "rm -rf /" },
        tool_use_id: "h1",
      } as never,
      "h1",
      { signal: new AbortController().signal },
    );
    const perms = buildToolPermissions(p);
    await perms.canUseTool(ASK_USER_QUESTION_TOOL_NAME, {}, {
      toolUseID: "c1",
      signal: new AbortController().signal,
    } as never);
    expect(seen).toEqual(["h1", "c1"]);
  });
});
