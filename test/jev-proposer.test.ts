import { expect, test } from "bun:test";
import { loadConfig } from "../src/config/agent-config";
import type { IntentDeps } from "../src/intent/decide-intent";
import { buildIntentDeps } from "../src/intent/intent-deps";
import { type JevClient, JevError, type JevRaw } from "../src/intent/jev/jev-client";
import { createJevProposer } from "../src/intent/jev/jev-proposer";
import { decideRoute } from "../src/routing/routing-policy";
import { makeEnv } from "./helpers";
import {
  BG,
  FG,
  haiku,
  input,
  pipeline,
  tagOf,
  VAGUE,
  verdict,
  waitingTask,
} from "./routing-policy-fixtures";

const SECRET = "API_KEY=supersecretvalue1234567890";
const usage = { input_tokens: 10, output_tokens: 2 };

/** Fake Jev client: records every request, answers with `answers` (or throws). */
function fakeClient(reply: JevRaw["answers"] | Error) {
  const calls: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const client: JevClient = {
    ask: async (state, questions) => {
      calls.push({ state, questions });
      if (reply instanceof Error) throw reply;
      return { answers: reply, usage };
    },
  };
  return { client, calls };
}
const answers = (probs: Record<string, number>, extra: Record<string, unknown> = {}) => {
  const [choice] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
  return {
    role: { type: "choice", choice, probabilities: probs, confidence: 0.9 },
    multi_intent: { type: "noul", noul: 0.05 },
    ...extra,
  };
};
const decisive = () => answers({ [FG]: 0.9, [BG]: 0.05, unclear: 0.05 });
const base = { text: "what is alpha", threadId: "th", recent: [] };
const deps = (client: JevClient, h = haiku()): { d: IntentDeps; h: ReturnType<typeof haiku> } => ({
  d: { pipeline, classifier: h.classifier, engine: "jev", proposer: createJevProposer(client) },
  h,
});

test("proposer: decisive answer -> pick, numbers + ms in scores, state carries no secret", async () => {
  const f = fakeClient(decisive());
  const p = await createJevProposer(f.client).propose({ ...base, text: `x ${SECRET}` });
  expect(p).toMatchObject({ kind: "pick", role: FG });
  expect(p.scores).toMatchObject({ top: 0.9, band: "pick", ms: expect.any(Number) });
  expect(JSON.stringify(f.calls)).not.toContain("supersecretvalue");
  expect(Object.keys(f.calls[0]!.questions)).toEqual(["role", "multi_intent"]);
});

test("proposer: error matrix -> undecided with a reason, never throws", async () => {
  const cases: [Error | JevRaw["answers"], string][] = [
    [new JevError("timeout", "t"), "timeout"],
    [new JevError("error", "401"), "error"],
    [new Error("429 rate limited"), "error"],
    [new DOMException("aborted", "AbortError"), "error"],
    [{ role: "garbage" }, "invalid_answer"],
    [answers({ ghost: 1 }), "invalid_answer"],
  ];
  for (const [reply, reason] of cases) {
    const p = await createJevProposer(fakeClient(reply).client).propose(base);
    expect(p).toMatchObject({ kind: "undecided", reason });
  }
});

test("policy: a decisive Jev pick routes with ZERO Haiku calls and one Jev request", async () => {
  const f = fakeClient(decisive());
  const { d, h } = deps(f.client);
  const plan = await decideRoute(input(makeEnv(), "what is alpha"), d);
  expect(plan.decision).toMatchObject({ kind: "role", role: FG });
  expect(plan.routing.source).toBe("jev");
  expect(plan.extra.jev).toMatchObject({ top: 0.9, band: "pick" });
  expect(h.inputs).toHaveLength(0);
  expect(f.calls).toHaveLength(1);
});

test("policy: undecided / every failure -> exactly one Haiku L3 call", async () => {
  const replies = [
    answers({ unclear: 0.9, [FG]: 0.1 }),
    new JevError("timeout", "t"),
    new Error("529"),
    { nope: 1 },
  ];
  for (const r of replies) {
    const f = fakeClient(r);
    const { d, h } = deps(f.client, haiku(verdict({ role: FG })));
    const plan = await decideRoute(input(makeEnv(), VAGUE), d);
    expect(h.inputs).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(plan.decision).toMatchObject({ kind: "role", role: FG });
  }
});

test("policy: open task + continues_task >= 0.8 continues the owner's task, no Haiku", async () => {
  const env = waitingTask();
  const f = fakeClient(
    answers(
      { [FG]: 0.4, [BG]: 0.4, unclear: 0.2 },
      { continues_task: { type: "noul", noul: 0.95 } },
    ),
  );
  const { d, h } = deps(f.client);
  const plan = await decideRoute(input(env, "yes go on"), d);
  expect(plan.continueTask?.taskId).toBe(env.task.taskId);
  expect(plan.routing.source).toBe("owner");
  expect(h.inputs).toHaveLength(0);
  expect(Object.keys(f.calls[0]!.questions)).toContain("continues_task");
});

test("policy: not called on a tag, a pending question or a busy thread", async () => {
  const f = fakeClient(decisive());
  const { d } = deps(f.client);
  await decideRoute(input(makeEnv(), `${tagOf(FG)} hi`), d);
  await decideRoute(input(makeEnv(), "yes", { pendingQuestion: "ok?" }), d);
  await decideRoute(input(makeEnv(), "more", { busy: true, state: "running" }), d);
  expect(f.calls).toHaveLength(0);
});

test("startup wiring: jev + client -> proposer + Haiku fallback; jev without key -> Haiku only; haiku / none -> no proposer", () => {
  const env = makeEnv();
  const cfg = (engine: "jev" | "haiku" | "none", jevApiKey?: string) => ({
    ...env.config,
    intent: { ...env.config.intent, engine, jevApiKey },
  });
  const fake = fakeClient(decisive()).client;
  const jev = buildIntentDeps(cfg("jev"), undefined, fake);
  expect(jev.engine).toBe("jev");
  expect(jev.proposer).toBeDefined();
  expect(jev.classifier).toBeDefined();
  const real = buildIntentDeps(cfg("jev", "jev-test-key"));
  expect(real.proposer).toBeDefined();
  const nokey = buildIntentDeps(cfg("jev")); // the bot still starts
  expect(nokey.proposer).toBeUndefined();
  expect(nokey.classifier).toBeDefined();
  const h = buildIntentDeps(cfg("haiku", "k"), undefined, fake);
  expect(h.proposer).toBeUndefined();
  expect(h.classifier).toBeDefined();
  const none = buildIntentDeps(cfg("none"));
  expect(none.proposer).toBeUndefined();
  expect(none.classifier).toBeUndefined();
});

test("config: JEV_API_KEY real vs missing / placeholder / sk_ stub", () => {
  const c = (JEV_API_KEY?: string) =>
    loadConfig({ AGENT_HOME: "/tmp/x", ...(JEV_API_KEY !== undefined && { JEV_API_KEY }) }).intent
      .jevApiKey;
  expect(c("abc123")).toBe("abc123");
  for (const v of [undefined, "", "REPLACE_ME", "sk_"]) expect(c(v)).toBeUndefined();
});
