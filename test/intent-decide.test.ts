import { expect, test } from "bun:test";
import { createAliasRouter } from "../src/intent/alias-router";
import { type DecideInput, decideIntent, type IntentDeps } from "../src/intent/decide-intent";
import {
  type IntentClassifier,
  IntentEngineError,
  type IntentInput,
  type IntentResult,
} from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { captureLogs } from "../src/observability/logger";
import { ROLES } from "../src/roles/role-registry";

const pipeline = { lexicon: loadLexicon(), aliasRouter: createAliasRouter(Object.values(ROLES)) };
const answer = (o: Partial<IntentResult> = {}): IntentResult => ({
  role: "dev",
  scope: "new",
  confidence: "high",
  reason: "r",
  ...o,
});

/** A fake L4 engine that counts its calls and records its inputs. */
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
  l4Input: () => ({ text, thread: { state: "idle" }, ledger: [], roles: [] }),
  ...over,
});
const run = (d: IntentDeps, i: DecideInput) => decideIntent(i, d);
// Undecided by L1-L3: no alias, no gate
const VAGUE = "can you look at the auth thing";

test("L4 is never called for a gate answer or a unique alias", async () => {
  const e = engine(answer());
  const d = { pipeline, classifier: e.classifier };
  const gate = await run(d, input("ok", { state: "awaiting_plan_approval" }));
  expect(gate.decision).toEqual({ kind: "gate-answer", answer: "yes", target: "gate" });
  const ask = await run(d, input("yes", { pendingAsk: true, state: "running" }));
  expect(ask.decision).toEqual({ kind: "gate-answer", answer: "yes", target: "ask" });
  const tagged = await run(d, input("[dev] fix the retry"));
  expect(tagged.decision).toMatchObject({ kind: "role", role: "dev", scope: "new" });
  const strong = await run(d, input("giao cho dev sửa lỗi này"));
  expect(strong.decision).toMatchObject({ kind: "role", role: "dev" });
  expect(e.inputs).toHaveLength(0);
});

test("L3 scope is derived by code: active only when the thread has a task", async () => {
  const d = { pipeline, classifier: engine(answer()).classifier };
  expect((await run(d, input("[dev] more", { hasTask: true }))).decision).toMatchObject({
    scope: "active",
  });
  expect((await run(d, input("[dev] more"))).decision).toMatchObject({ scope: "new" });
});

test("an undecided message reaches L4 exactly once", async () => {
  const e = engine(answer({ class: "design" }));
  const r = await run({ pipeline, classifier: e.classifier }, input(VAGUE));
  expect(e.inputs).toHaveLength(1);
  expect(r.decision).toEqual({ kind: "role", role: "dev", scope: "new", cls: "design" });
});

test("owner prefix class beats the model class; L4 scope is forced new without a task", async () => {
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

test("low confidence -> ONE owner question (no role); medium proceeds", async () => {
  const low = await run(
    { pipeline, classifier: engine(answer({ confidence: "low" })).classifier },
    input(VAGUE),
  );
  expect(low.decision).toEqual({ kind: "ask", reason: "low_confidence" });
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
    for (const state of ["running", "awaiting_plan_approval", "awaiting_result"] as const)
      expect((await run(d, input(VAGUE, { state, hasTask: true }))).decision).toEqual({
        kind: "ask",
        reason: "unclassified",
      });
  }
  // an engine that throws something else counts as an sdk failure
  const d = { pipeline, classifier: engine(new Error("boom")).classifier };
  expect((await run(d, input(VAGUE))).decision).toMatchObject({ role: "assistant" });
});

test("engine none: L0-L3 only; ambiguous -> entry role when idle, else ask", async () => {
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

test("effort signals are returned whoever decides, and the L4 class hint feeds the class", async () => {
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
  await run(ok, input("ok", { state: "awaiting_result" }));
  await run(ok, input("[dev] SECRET-TEXT-1"));
  await run(ok, input("SECRET-TEXT-2 vague"));
  await run(
    { pipeline, classifier: engine(new IntentEngineError("timeout", "t")).classifier },
    input("SECRET-TEXT-3"),
  );
  await run({ pipeline }, input("SECRET-TEXT-4"));
  cap.stop();
  const layers = cap.lines.filter((l) => l.event === "intent.layer").map((l) => l.layer);
  expect(layers).toEqual(["L1", "L3", "L4", "fallback", "none"]);
  expect(cap.lines.find((l) => l.event === "intent.classified")).toMatchObject({
    role: "dev",
    scope: "new",
    confidence: "high",
  });
  expect(cap.lines.find((l) => l.event === "intent.fallback")).toMatchObject({ reason: "timeout" });
  expect(JSON.stringify(cap.lines)).not.toContain("SECRET-TEXT");
});

test("the L4 input is built lazily, only when L4 runs", async () => {
  let built = 0;
  const d = { pipeline, classifier: engine(answer()).classifier };
  const lazy = (text: string) =>
    input(text, {
      l4Input: () => {
        built++;
        return { text, thread: { state: "idle" }, ledger: [], roles: [] };
      },
    });
  await run(d, lazy("[dev] x"));
  await run(d, { ...lazy("ok"), state: "awaiting_result" });
  expect(built).toBe(0);
  await run(d, lazy(VAGUE));
  expect(built).toBe(1);
});

test("the thread's stop signal is handed to the L4 call", async () => {
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
