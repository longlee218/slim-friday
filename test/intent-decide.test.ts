import { expect, test } from "bun:test";
import { type DecideInput, decideIntent, type IntentDeps } from "../src/intent/decide-intent";
import {
  type IntentClassifier,
  IntentEngineError,
  type IntentInput,
  type IntentResult,
} from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { captureLogs } from "../src/observability/logger";
import { ROLES } from "../src/roles/role-registry";

const pipeline = { lexicon: loadLexicon(), tagRouter: createRoleTagRouter(Object.values(ROLES)) };
const answer = (o: Partial<IntentResult> = {}): IntentResult => ({
  role: "dev",
  scope: "new",
  confidence: "high",
  reason: "r",
  ...o,
});

/** A fake L3 engine that counts its calls and records its inputs. */
function engine(result: IntentResult | Error) {
  const inputs: IntentInput[] = [];
  const classifier: IntentClassifier = {
    classify: async (i) => {
      inputs.push(i);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { classifier, inputs };
}

const input = (text: string, over: Partial<DecideInput> = {}): DecideInput => ({
  text,
  state: "idle",
  hasTask: false,
  l3Input: () => ({ text, thread: { state: "idle" }, ledger: [], recent: [], roles: [] }),
  ...over,
});
const run = (d: IntentDeps, i: DecideInput) => decideIntent(i, d);
// Undecided by L1 (no leading tag): L3 decides
const VAGUE = "can you look at the auth thing";

test("L3 is never called for an explicit leading tag; words without a tag are not a route", async () => {
  const e = engine(answer({ role: "assistant" }));
  const d = { pipeline, classifier: e.classifier };
  const tagged = await run(d, input("[dev] fix the retry"));
  expect(tagged.decision).toMatchObject({ kind: "role", role: "dev", scope: "new" });
  expect(e.inputs).toHaveLength(0);
  // dev wording without a tag goes to the model, which decides
  const words = await run(d, input("giao cho dev sửa lỗi này"));
  expect(words.decision).toMatchObject({ kind: "role", role: "assistant" });
  expect(e.inputs).toHaveLength(1);
});

test("pending answers come from L3 only: yes/no to a pending question (ask) or a gate; ignored when nothing waits", async () => {
  const yes = answer({ pendingAnswer: "yes" });
  const d = { pipeline, classifier: engine(yes).classifier };
  const ask = await run(d, input("okay đồng ý", { state: "running", pendingQuestion: "Run it?" }));
  expect(ask.decision).toEqual({ kind: "gate-answer", answer: "yes", target: "ask" });
  const gate = await run(d, input("ok", { state: "awaiting_plan_approval" }));
  expect(gate.decision).toEqual({ kind: "gate-answer", answer: "yes", target: "gate" });
  // a pending proposal wins over the button gate
  const both = await run(
    { pipeline, classifier: engine(answer({ pendingAnswer: "no" })).classifier },
    input("không", { state: "awaiting_plan_approval", pendingQuestion: "Run it?" }),
  );
  expect(both.decision).toEqual({ kind: "gate-answer", answer: "no", target: "ask" });
  // nothing waits: the model's pendingAnswer is ignored, the message is routed as usual
  const none = await run(d, input("ok", { state: "idle" }));
  expect(none.decision).toMatchObject({ kind: "role" });
  // the model says the message is not an answer: normal routing even with a question pending
  const other = await run(
    { pipeline, classifier: engine(answer()).classifier },
    input("add a cache too", { pendingQuestion: "Run it?" }),
  );
  expect(other.decision).toMatchObject({ kind: "role", role: "dev" });
});

test("L3 gets the pending question and recent messages through its input builder", async () => {
  const e = engine(answer({ pendingAnswer: "no" }));
  await run(
    { pipeline, classifier: e.classifier },
    input("thôi", {
      pendingQuestion: "Open a dev task for this?",
      l3Input: () => ({
        text: "thôi",
        thread: { state: "idle" },
        ledger: [],
        recent: [{ from: "bot", text: "Open a dev task for this?" }],
        pendingQuestion: "Open a dev task for this?",
        roles: [],
      }),
    }),
  );
  expect(e.inputs[0]?.pendingQuestion).toBe("Open a dev task for this?");
  expect(e.inputs[0]?.recent).toEqual([{ from: "bot", text: "Open a dev task for this?" }]);
});

test("L3 failure or no engine while a question is pending -> re-ask naturally, never a role", async () => {
  const fail = {
    pipeline,
    classifier: engine(new IntentEngineError("timeout", "t")).classifier,
  };
  const withQ = input("ok", { pendingQuestion: "Run it?" });
  expect((await run(fail, withQ)).decision).toEqual({ kind: "ask", reason: "pending_unclear" });
  expect((await run({ pipeline }, withQ)).decision).toEqual({
    kind: "ask",
    reason: "pending_unclear",
  });
});

test("L3 scope is derived by code: active only when the thread has a task", async () => {
  const d = { pipeline, classifier: engine(answer()).classifier };
  expect((await run(d, input("[dev] more", { hasTask: true }))).decision).toMatchObject({
    scope: "active",
  });
  expect((await run(d, input("[dev] more"))).decision).toMatchObject({ scope: "new" });
});

test("an undecided message reaches L3 exactly once", async () => {
  const e = engine(answer({ class: "design" }));
  const r = await run({ pipeline, classifier: e.classifier }, input(VAGUE));
  expect(e.inputs).toHaveLength(1);
  expect(r.decision).toEqual({ kind: "role", role: "dev", scope: "new", cls: "design" });
});

test("owner prefix class beats the model class; L3 scope is forced new without a task", async () => {
  const e = engine(answer({ class: "mechanical", scope: "active" }));
  const d = { pipeline, classifier: e.classifier };
  const r = await run(d, input(VAGUE, { ownerClass: "design" }));
  expect(r.decision).toEqual({ kind: "role", role: "dev", scope: "new", cls: "design" });
  const withTask = await run(d, input(VAGUE, { hasTask: true, state: "running" }));
  expect(withTask.decision).toMatchObject({ scope: "active" });
});

test("class is dropped for a role without class tiers", async () => {
  const e = engine(answer({ role: "assistant", class: "design" }));
  const r = await run({ pipeline, classifier: e.classifier }, input(VAGUE));
  expect(r.decision).toEqual({ kind: "role", role: "assistant", scope: "new" });
});

test("low confidence: idle -> entry role (never the model's pick); pending / busy -> owner question; medium proceeds", async () => {
  const low = await run(
    { pipeline, classifier: engine(answer({ role: "dev", confidence: "low" })).classifier },
    input(VAGUE),
  );
  expect(low.decision).toEqual({ kind: "role", role: "assistant", scope: "new" });
  // a pending question keeps the owner question (the model's own text is carried)
  const own = await run(
    {
      pipeline,
      classifier: engine(answer({ confidence: "low", ask: "Ý bạn là gì?", pendingAnswer: "yes" }))
        .classifier,
    },
    input(VAGUE, { pendingQuestion: "Run it?" }),
  );
  expect(own.decision).toEqual({ kind: "ask", reason: "low_confidence", text: "Ý bạn là gì?" });
  // a busy thread keeps the ask (the executor answers `still working...`)
  const busy = await run(
    { pipeline, classifier: engine(answer({ confidence: "low" })).classifier },
    input(VAGUE, { state: "running", hasTask: true }),
  );
  expect(busy.decision).toEqual({ kind: "ask", reason: "low_confidence" });
  const mid = await run(
    { pipeline, classifier: engine(answer({ confidence: "medium" })).classifier },
    input(VAGUE),
  );
  expect(mid.decision).toMatchObject({ kind: "role", role: "dev" });
});

test("unknown role -> ask the owner, whatever the state", async () => {
  const d = { pipeline, classifier: engine(answer({ role: "admin" })).classifier };
  expect((await run(d, input(VAGUE))).decision).toEqual({ kind: "ask", reason: "unknown_role" });
  expect((await run(d, input(VAGUE, { state: "running" }))).decision).toEqual({
    kind: "ask",
    reason: "unknown_role",
  });
});

test("engine failure: idle / done -> entry role; any other state -> ask; never a dispatch", async () => {
  for (const reason of ["timeout", "sdk", "budget", "schema"] as const) {
    const d = { pipeline, classifier: engine(new IntentEngineError(reason, "x")).classifier };
    for (const state of ["idle", "done"] as const)
      expect((await run(d, input(VAGUE, { state }))).decision).toEqual({
        kind: "role",
        role: "assistant",
        scope: "new",
      });
    for (const state of ["running", "awaiting_plan_approval"] as const)
      expect((await run(d, input(VAGUE, { state, hasTask: true }))).decision).toEqual({
        kind: "ask",
        reason: "unclassified",
      });
  }
  // an engine that throws something else counts as an sdk failure
  const d = { pipeline, classifier: engine(new Error("boom")).classifier };
  expect((await run(d, input(VAGUE))).decision).toMatchObject({ role: "assistant" });
});

test("engine none: L0-L2 only; ambiguous -> entry role when idle, else ask", async () => {
  const d = { pipeline };
  expect((await run(d, input(VAGUE))).decision).toEqual({
    kind: "role",
    role: "assistant",
    scope: "new",
  });
  expect((await run(d, input(VAGUE, { state: "running" }))).decision).toEqual({
    kind: "ask",
    reason: "unclassified",
  });
  expect((await run(d, input("[dev] x"))).decision).toMatchObject({ role: "dev" });
});

test("effort signals are returned whoever decides, and the L2 class hint feeds the class", async () => {
  const e = engine(answer({ class: undefined }));
  const r = await run(
    { pipeline, classifier: e.classifier },
    input("thiết kế lại hệ thống auth cho tôi"),
  );
  expect(r.effort.ruleIds.length).toBeGreaterThan(0);
  expect(r.effort.classHint).toBe("design");
  expect(r.decision).toMatchObject({ cls: "design" });
});

test("logs: intent.layer for each deciding layer, intent.classified and intent.fallback without text", async () => {
  const cap = captureLogs();
  const ok = { pipeline, classifier: engine(answer()).classifier };
  await run(ok, input("[dev] SECRET-TEXT-1"));
  await run(ok, input("SECRET-TEXT-2 vague"));
  await run(
    { pipeline, classifier: engine(new IntentEngineError("timeout", "t")).classifier },
    input("SECRET-TEXT-3"),
  );
  await run({ pipeline }, input("SECRET-TEXT-4"));
  cap.stop();
  const layers = cap.lines.filter((l) => l.event === "intent.layer").map((l) => l.layer);
  expect(layers).toEqual(["L1", "L3", "fallback", "none"]);
  expect(cap.lines.find((l) => l.event === "intent.classified")).toMatchObject({
    role: "dev",
    scope: "new",
    confidence: "high",
  });
  expect(cap.lines.find((l) => l.event === "intent.fallback")).toMatchObject({ reason: "timeout" });
  expect(JSON.stringify(cap.lines)).not.toContain("SECRET-TEXT");
});

test("the L3 input is built lazily, only when L3 runs", async () => {
  let built = 0;
  const d = { pipeline, classifier: engine(answer()).classifier };
  const lazy = (text: string) =>
    input(text, {
      l3Input: () => {
        built++;
        return { text, thread: { state: "idle" }, ledger: [], recent: [], roles: [] };
      },
    });
  await run(d, lazy("[dev] x"));
  expect(built).toBe(0);
  await run(d, lazy(VAGUE));
  expect(built).toBe(1);
});

test("the thread's stop signal is handed to the L3 call", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const classifier: IntentClassifier = {
    classify: async (_i, signal) => {
      signals.push(signal);
      return answer();
    },
  };
  const ac = new AbortController();
  await run({ pipeline, classifier }, input(VAGUE, { signal: ac.signal }));
  expect(signals).toEqual([ac.signal]);
});

test("a medium-confidence `mechanical` is downgraded to standard; high stays mechanical", async () => {
  const run1 = (confidence: "high" | "medium") =>
    run(
      { pipeline, classifier: engine(answer({ class: "mechanical", confidence })).classifier },
      input(VAGUE),
    );
  expect((await run1("medium")).decision).toMatchObject({ role: "dev", cls: "standard" });
  expect((await run1("high")).decision).toMatchObject({ role: "dev", cls: "mechanical" });
});

test("scopeFromModel (a steerable run works): a tag picks the role only, L3 decides the scope; unclear = supplement", async () => {
  const busy = { state: "running" as const, hasTask: true, scopeFromModel: true };
  // tagged + L3 says independent: role from the tag, scope new (-> queue), class from the tag path
  const indep = engine(answer({ role: "assistant", scope: "new" }));
  const a = await run({ pipeline, classifier: indep.classifier }, input("[dev] other task", busy));
  expect(a.decision).toMatchObject({ kind: "role", role: "dev", scope: "new" });
  expect(indep.inputs).toHaveLength(1); // the tag no longer spares the L3 call
  // tagged + L3 says supplement
  const sup = engine(answer({ scope: "active" }));
  const b = await run({ pipeline, classifier: sup.classifier }, input("[dev] also this", busy));
  expect(b.decision).toMatchObject({ role: "dev", scope: "active" });
  // ambiguous: low confidence, engine failure, unknown role, no engine -> supplement (tagged and untagged)
  const cases: [string, IntentDeps][] = [
    [
      "[dev] hmm",
      { pipeline, classifier: engine(answer({ confidence: "low", scope: "new" })).classifier },
    ],
    [
      "[dev] hmm",
      { pipeline, classifier: engine(new IntentEngineError("timeout", "slow")).classifier },
    ],
    [
      "[dev] hmm",
      { pipeline, classifier: engine(answer({ role: "nope", scope: "new" })).classifier },
    ],
    ["[dev] hmm", { pipeline }],
    [
      VAGUE,
      { pipeline, classifier: engine(answer({ confidence: "low", scope: "new" })).classifier },
    ],
    [VAGUE, { pipeline, classifier: engine(new Error("down")).classifier }],
    [VAGUE, { pipeline, classifier: engine(answer({ role: "nope" })).classifier }],
    [VAGUE, { pipeline }],
  ];
  for (const [text, d] of cases) {
    const r = await run(d, input(text, busy));
    expect(r.decision).toMatchObject({ kind: "role", scope: "active" });
  }
  // untagged + L3 independent: its own role and scope are kept
  const own = engine(answer({ role: "assistant", scope: "new" }));
  const c = await run({ pipeline, classifier: own.classifier }, input(VAGUE, busy));
  expect(c.decision).toMatchObject({ role: "assistant", scope: "new" });
});

test("without scopeFromModel a tag still sets scope from hasTask and L3 is not called (a run without steer)", async () => {
  const e = engine(answer({ scope: "active" }));
  const d = { pipeline, classifier: e.classifier };
  const noTask = await run(d, input("[dev] x", { state: "running", hasTask: false }));
  expect(noTask.decision).toMatchObject({ role: "dev", scope: "new" });
  expect(e.inputs).toHaveLength(0);
});
