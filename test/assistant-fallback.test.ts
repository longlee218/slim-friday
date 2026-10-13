import { describe, expect, test } from "bun:test";
import { type Route, TASK_BUDGET_USD } from "../src/config/model-routing";
import { emptyUsage } from "../src/observability/record-run";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import { answerOutput, FALLBACK_RETRY_HINT } from "../src/orchestrator/outputs/answer-output";
import {
  FALLBACK_TOOL_ERRORS,
  fallbackReason,
  looksUnsure,
  UNSURE_MAX_CHARS,
} from "../src/orchestrator/outputs/escalation-signals";
import { ASSISTANT_ROLE } from "../src/roles/builtin/assistant-role";
import type { RunAgentResult } from "../src/runtime/run-agent";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { fakeQuery, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const CONFIDENT = "The cache expires entries after 60s, see src/cache.ts:42. ".repeat(3);

/** A finished run with the given outcome / text / usage overrides. */
const res = (
  over: Partial<RunAgentResult> & { toolErrors?: number; toolDenied?: number; cost?: number } = {},
): RunAgentResult => {
  const { toolErrors = 0, toolDenied = 0, cost = 0.1, ...rest } = over;
  return {
    text: CONFIDENT,
    sessionId: "s0",
    outcome: "success",
    usage: { ...emptyUsage(), toolErrors, toolDenied, costUsd: cost },
    ...rest,
  };
};

/** Drive answerOutput with scripted runs; returns the result, the routes the runs got and the confirm count. */
async function drive(
  runs: RunAgentResult[],
  o: {
    route?: Route;
    env?: Record<string, string>;
    confirm?: boolean;
    awaiting?: () => boolean;
  } = {},
) {
  const { config } = makeEnv(o.env);
  const routes: (Route | undefined)[] = [];
  const sessions: (string | undefined)[] = [];
  let confirms = 0;
  const out = await answerOutput({
    role: ASSISTANT_ROLE,
    config,
    route: o.route,
    resume: "s-thread",
    awaitingOwner: o.awaiting,
    run: async (r, sid) => {
      routes.push(r);
      sessions.push(sid);
      return runs[routes.length - 1] ?? res({ text: "extra" });
    },
    confirmOpus: async () => {
      confirms++;
      return o.confirm ?? false;
    },
  });
  return { out, routes, sessions, confirms };
}

describe("unsure detection", () => {
  test("clear whole-answer give-ups (EN + VI, markdown wrapped) are unsure", () => {
    for (const t of [
      "I could not find that in the repo.",
      "**I couldn't find it.**",
      "> I couldn't find any config for the queue.",
      "- Unfortunately, I don't have enough information.",
      "Tôi không tìm thấy hàm này trong repo.",
      "Mình không tìm thấy file cấu hình.",
      "Xin lỗi, không đủ thông tin để trả lời.",
    ])
      expect(looksUnsure(t)).toBe(true);
  });
  test("caveats, answers with content, questions and long replies are NOT unsure", () => {
    for (const t of [
      "I'm not sure the API supports X, but here is how you can check it: call getX().",
      "I'm not sure about this one.",
      "Mình không chắc về phần này.",
      "I couldn't find a config for X, but the default is in src/a.ts:3",
      "I couldn't find it. See src/a.ts:3",
      "I don't know which repo you mean, which one?",
      "I couldn't find it, which repo do you mean?",
      "Looked through the docs, but I couldn't find it.",
      "I couldn't find it.\n\n```ts\nconst x = 1;\n```",
      `${"Cơ chế cache hoạt động như sau, đọc src/cache.ts:12. ".repeat(4)}Tôi không chắc về phần TTL.`,
      `${CONFIDENT}I'm not sure about edge cases.`,
      `I could not find it. ${"x".repeat(UNSURE_MAX_CHARS)}`,
      "",
    ])
      expect(looksUnsure(t)).toBe(false);
  });
  test("fallbackReason: limits, tool errors (not denials), unsure; failures never", () => {
    expect(fallbackReason(res({ outcome: "max_turns" }))).toBe("max_turns");
    expect(fallbackReason(res({ outcome: "max_budget" }))).toBe("max_budget");
    expect(fallbackReason(res({ toolErrors: FALLBACK_TOOL_ERRORS }))).toBe("tool_errors");
    expect(fallbackReason(res({ toolErrors: FALLBACK_TOOL_ERRORS - 1 }))).toBeUndefined();
    expect(fallbackReason(res({ toolDenied: 20 }))).toBeUndefined();
    expect(fallbackReason(res({ text: "I could not find it." }))).toBe("unsure");
    expect(fallbackReason(res({ text: "Tôi không tìm thấy nó." }))).toBe("unsure");
    expect(fallbackReason(res({ outcome: "error", toolErrors: 9 }))).toBeUndefined();
    expect(fallbackReason(res({ outcome: "aborted" }))).toBeUndefined();
    expect(fallbackReason(res())).toBeUndefined();
  });
});

describe("objective fallback in answerOutput", () => {
  const SONNET = "claude-sonnet-5-5";
  test.each([
    ["max_turns", res({ outcome: "max_turns", text: "" }), "turn limit reached"],
    ["max_budget", res({ outcome: "max_budget", text: "" }), "budget reached"],
    ["4 tool errors", res({ toolErrors: 4 }), "many tool errors"],
    ["unsure phrase", res({ text: "I could not find it." }), "unsure answer"],
  ])(
    "%s: exactly one Sonnet re-run, resumed, escalated budget, prefixed",
    async (_n, first, label) => {
      const { out, routes } = await drive([first, res({ text: "Real answer, src/a.ts:1" })]);
      expect(routes).toHaveLength(2);
      expect(routes[1]).toMatchObject({ tier: "sonnet", escalated: true });
      expect(out.text).toBe(`Re-run on Sonnet (${label}).\n\nReal answer, src/a.ts:1`);
    },
  );
  test("session: a limit hit resumes the work done; every reason resumes the first run's session; the hint only for unsure / tool errors", async () => {
    for (const [first, resumed] of [
      [res({ outcome: "max_turns", text: "", sessionId: "s1" }), "s1"],
      [res({ outcome: "max_budget", text: "", sessionId: "s1" }), "s1"],
      [res({ toolErrors: 4, sessionId: "s1" }), "s1"],
      [res({ text: "I could not find it.", sessionId: "s1" }), "s1"],
    ] as const) {
      const { sessions, routes } = await drive([first, res()]);
      expect(sessions).toEqual(["s-thread", resumed]);
      const limit = first.outcome !== "success";
      expect(routes[1]?.promptHint).toBe(limit ? undefined : FALLBACK_RETRY_HINT);
    }
  });
  test("Vietnamese and bolded give-ups re-run through answerOutput; a caveat answer does not", async () => {
    for (const t of ["Tôi không tìm thấy nó.", "**I couldn't find it.**"]) {
      const { routes } = await drive([res({ text: t }), res()]);
      expect(routes).toHaveLength(2);
    }
    const { routes } = await drive([
      res({ text: "I'm not sure the API supports X, but see src/a.ts:3" }),
    ]);
    expect(routes).toHaveLength(1);
  });
  test("an empty re-run keeps the successful first answer", async () => {
    const { out } = await drive([res({ text: "I could not find it." }), res({ text: "  " })]);
    expect(out.text).toBe("I could not find it.");
  });
  test("ceiling left below the minimum: no re-run; awaiting an owner answer: no fallback", async () => {
    const low = await drive([res({ toolErrors: 4, cost: 0.05 })], {
      route: { spentUsd: TASK_BUDGET_USD - 0.1 },
    });
    expect(low.routes).toHaveLength(1);
    const wait = await drive([res({ toolErrors: 4 })], { awaiting: () => true });
    expect(wait.routes).toHaveLength(1);
  });
  test("the re-run never re-escalates: a second ESCALATE line is dropped", async () => {
    const { out, routes } = await drive([
      res({ toolErrors: 5 }),
      res({ text: "Answer\nESCALATE: opus" }),
    ]);
    expect(routes).toHaveLength(2);
    expect(out.text).toBe("Re-run on Sonnet (many tool errors).\n\nAnswer");
  });
  test("confident answer, denials alone, 3 tool errors: no re-run", async () => {
    for (const first of [res(), res({ toolDenied: 30 }), res({ toolErrors: 3 })]) {
      const { out, routes } = await drive([first]);
      expect(routes).toHaveLength(1);
      expect(out).toBe(first);
    }
  });
  test("an ESCALATE answer plus a fallback trigger runs once (the model's ask wins)", async () => {
    const { out, routes } = await drive([
      res({ text: "no idea\nESCALATE: sonnet", toolErrors: 6 }),
      res({ text: "Real answer" }),
    ]);
    expect(routes).toHaveLength(2);
    expect(out.text).toBe("Escalated to Sonnet.\n\nReal answer");
  });
  test("a failed re-run keeps a successful first answer; a failed re-run of a limit hit is returned", async () => {
    const bad = res({ outcome: "error", text: "boom" });
    const a = await drive([res({ text: "I could not find it." }), bad]);
    expect(a.out.text).toBe("I could not find it.");
    const b = await drive([res({ outcome: "max_turns", text: "" }), bad]);
    expect(b.out).toBe(bad);
  });
  test("escalated budget: the re-run carries the spend so far and the role's escalated budget", async () => {
    const { routes } = await drive([res({ toolErrors: 4, cost: 0.4 }), res()], {
      route: { spentUsd: 1 },
    });
    expect(routes[1]?.spentUsd).toBeCloseTo(1.4);
  });
  test("task ceiling used up by the first run: no re-run, original answer plus a note", async () => {
    const { out, routes } = await drive([res({ toolErrors: 4, cost: 0.5 })], {
      route: { spentUsd: TASK_BUDGET_USD - 0.5 },
    });
    expect(routes).toHaveLength(1);
    expect(out.text).toContain("ceiling");
    const esc = await drive([res({ text: "x\nESCALATE: sonnet", cost: 0.5 })], {
      route: { spentUsd: TASK_BUDGET_USD - 0.5 },
    });
    expect(esc.routes).toHaveLength(1);
    expect(esc.out.text).toContain("ceiling");
    expect(esc.out.text).not.toContain("ESCALATE");
  });
  test("owner-forced tier, Sonnet/Opus base, pin: no automatic fallback", async () => {
    const cases: Parameters<typeof drive>[1][] = [
      { route: { tier: "sonnet" } as Route },
      { route: { cls: "design" } as Route },
      { env: { MODEL_ASSISTANT: "claude-haiku-4-5-20251001" } },
      { env: { OPENROUTER_API_KEY: `sk-or-v1-${"a1b2c3d4".repeat(8)}` } },
    ];
    for (const o of cases) {
      const { routes } = await drive([res({ toolErrors: 9 })], o);
      expect(routes).toHaveLength(1);
    }
  });
  test("Sonnet resolved model is the claude-sonnet-5-5 default", () => {
    expect(makeEnv().config.models.sonnet).toBe(SONNET);
  });
});

describe("canEscalate with a Sonnet base (design class)", () => {
  const design: Route = { cls: "design" };
  test("offers only opus; the prompt lists only the reachable tier", async () => {
    const { routes } = await drive([res()], { route: design });
    expect(routes[0]?.offerEscalation).toEqual(["opus"]);
    const sys = buildSystemPrompt("", ASSISTANT_ROLE, { escalationTiers: ["opus"] }).append;
    expect(sys).toContain("ESCALATE: opus");
    expect(sys).not.toContain("ESCALATE: sonnet");
    const both = buildSystemPrompt("", ASSISTANT_ROLE, { escalationTiers: ["sonnet", "opus"] });
    expect(both.append).toContain("ESCALATE: sonnet");
  });
  test("ESCALATE: opus still asks the owner; yes -> one Opus re-run, no -> kept", async () => {
    const yes = await drive([res({ text: "hmm\nESCALATE: opus" }), res({ text: "deep" })], {
      route: design,
      confirm: true,
    });
    expect(yes.confirms).toBe(1);
    expect(yes.routes[1]).toMatchObject({ tier: "opus", ownerConfirmedMax: true });
    expect(yes.out.text).toBe("Escalated to Opus.\n\ndeep");
    const no = await drive([res({ text: "hmm\nESCALATE: opus" })], { route: design });
    expect(no.routes).toHaveLength(1);
    expect(no.out.text).toContain("Not run on Opus");
  });
  test("ESCALATE: sonnet on a Sonnet base: no re-run, no confirm, one owner line", async () => {
    const { out, routes, confirms } = await drive([res({ text: "hmm\nESCALATE: sonnet" })], {
      route: design,
    });
    expect(routes).toHaveLength(1);
    expect(confirms).toBe(0);
    expect(out.text).toContain("not available");
  });
  test("Haiku base: both tiers offered", async () => {
    const { routes } = await drive([res()]);
    expect(routes[0]?.offerEscalation).toEqual(["sonnet", "opus"]);
  });
});

describe("[sonnet] prefix", () => {
  test("parsed in any order with other prefixes and stripped; haiku/opus are not prefixes", () => {
    expect(parseMessageCommand("[Sonnet] what is x?")).toMatchObject({
      tier: "sonnet",
      text: "what is x?",
    });
    expect(parseMessageCommand("repo:api [sonnet] [design] why?")).toMatchObject({
      tier: "sonnet",
      cls: "design",
      repo: "api",
      text: "why?",
    });
    for (const t of ["[opus] q", "[haiku] q"]) {
      const c = parseMessageCommand(t);
      expect(c).toMatchObject({ text: t });
      expect("tier" in c).toBe(false);
    }
  });
  test("[sonnet] after a role tag is read and removed; the role tag stays", () => {
    for (const [inp, tag] of [
      ["[ask] [sonnet] q", "[ask] q"],
      ["[dev] [Sonnet] q", "[dev] q"],
      ["[design] [sonnet] [ask] q", "[ask] q"],
    ] as const) {
      expect(parseMessageCommand(inp)).toMatchObject({ tier: "sonnet", text: tag });
    }
  });
  async function ask(text: string, answers: RunAgentResult["text"][], extra = {}) {
    const env = makeEnv(extra);
    const calls: { model?: string; prompt?: string; budget?: number }[] = [];
    const queryFn = (a: { prompt: string; options: { model?: string; maxBudgetUsd?: number } }) => {
      calls.push({ model: a.options.model, prompt: a.prompt, budget: a.options.maxBudgetUsd });
      const n = calls.length - 1;
      return fakeQuery([resultMsg({ result: answers[n] ?? "extra", session_id: `s${n}` })])(
        a as never,
      );
    };
    const reply = await createTurnHandler({
      db: env.db,
      config: env.config,
      queryFn: queryFn as never,
    })({ source: "t", channelId: TEST_CHANNEL, userId: "u", threadId: "t1", text });
    return { reply, calls };
  }
  test("runs the assistant on Sonnet with the tag stripped, no notice, no fallback", async () => {
    const { reply, calls } = await ask("[sonnet] where is x?", ["I could not find it."]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: "claude-sonnet-5-5", prompt: "where is x?" });
    expect(reply).toBe("I could not find it.");
  });
  test("without the prefix the same unsure answer falls back once, on Sonnet", async () => {
    const { reply, calls } = await ask("where is x?", ["I could not find it.", "It is in a.ts:1"]);
    expect(calls.map((c) => c.model)).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5-5"]);
    expect(calls.map((c) => c.budget)).toEqual([1, 2.5]); // escalated budget on the re-run
    expect(reply).toBe("Re-run on Sonnet (unsure answer).\n\nIt is in a.ts:1");
  });
});
