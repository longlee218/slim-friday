import { expect, test } from "bun:test";
import type { IntentDeps } from "../src/intent/decide-intent";
import { ROLES } from "../src/roles/role-registry";
import { settleRouting } from "../src/routing/route-decision-of";
import { decideRoute } from "../src/routing/routing-policy";
import { makeEnv } from "./helpers";
import {
  afterTurn,
  BG,
  FG,
  failing,
  haiku,
  input,
  pipeline,
  proposer,
  tagOf,
  VAGUE,
  verdict,
  waitingTask,
} from "./routing-policy-fixtures";

test("tags: the owner's role tag continues its waiting task (source tag); a foreground tag leaves it alone", async () => {
  const env = waitingTask();
  const deps: IntentDeps = { pipeline, classifier: haiku().classifier };
  const own = await decideRoute(input(env, `${tagOf(BG)} go on with the tests`), deps);
  expect(own.continueTask?.taskId).toBe(env.task.taskId);
  expect(own.routing).toMatchObject({ source: "tag", rationaleCode: "CONTEXT_CONTINUATION" });
  const fg = await decideRoute(input(env, `${tagOf(FG)} what is alpha`), deps);
  expect(fg.continueTask).toBeUndefined();
  expect(fg.routing).toMatchObject({ source: "tag", rationaleCode: "EXPLICIT_TAG" });
  // No waiting task: a background tag is a plain explicit tag.
  const none = await decideRoute(input(makeEnv(), `${tagOf(BG)} fix it`), deps);
  expect(none.routing.rationaleCode).toBe("EXPLICIT_TAG");
});

test("unresolved: the last role without side effects keeps the thread (HISTORY_DEFAULT, no question)", async () => {
  expect(ROLES[FG]!.sideEffects).toBe("none");
  const env = afterTurn(FG);
  const plan = await decideRoute(input(env, VAGUE, { state: "done" }), failing);
  expect(plan.decision).toMatchObject({ kind: "role", role: FG });
  expect(plan.routing).toMatchObject({ source: "fallback", rationaleCode: "HISTORY_DEFAULT" });
});

test("unresolved: a last role with side effects needs fitsLastP >= FIT_MIN, else the entry role", async () => {
  const env = afterTurn(BG);
  const undecided = (fitsLastP?: number) => ({
    ...failing,
    proposer: proposer({
      kind: "undecided",
      reason: "low_confidence",
      ...(fitsLastP !== undefined && { scores: { fitsLastP } }),
    }).impl,
  });
  const fits = await decideRoute(input(env, VAGUE, { state: "done" }), undecided(0.95));
  expect(fits.decision).toMatchObject({ kind: "role", role: BG, scope: "new" });
  expect(fits.routing.rationaleCode).toBe("HISTORY_DEFAULT");
  for (const d of [undecided(0.2), undecided(), failing]) {
    const plan = await decideRoute(input(env, VAGUE, { state: "done" }), d);
    expect(plan.decision).toMatchObject({ kind: "role", role: expect.not.stringMatching(BG) });
    expect(plan.routing.rationaleCode).toBe("ENTRY_DEFAULT");
  }
});

test("unresolved in a new thread: the entry role, ENTRY_DEFAULT", async () => {
  const plan = await decideRoute(input(makeEnv(), VAGUE), failing);
  expect(plan.routing).toMatchObject({ source: "fallback", rationaleCode: "ENTRY_DEFAULT" });
});

test("jev: an unusable Haiku answer on an idle thread is unresolved (no question); under haiku it still asks", async () => {
  const bad = haiku(verdict({ role: "ghost" })).classifier;
  const soft = await decideRoute(input(makeEnv(), VAGUE), {
    pipeline,
    classifier: bad,
    engine: "jev",
  });
  expect(soft.decision.kind).toBe("role");
  const hard = await decideRoute(input(makeEnv(), VAGUE), { pipeline, classifier: bad });
  expect(hard.decision.kind).toBe("ask");
});

test("settleRouting: a yes to a failed task is RESUME; a steer into the running run continues it", () => {
  const base = {
    messageId: "m",
    conversationId: "th",
    source: "fallback" as const,
    alternatives: [],
    rationaleCode: "MODEL_FALLBACK" as const,
    ambiguityFlags: [],
    routingVersion: "1",
    timestamp: "t",
  };
  expect(
    settleRouting(
      base,
      { kind: "answer-ask", answer: "yes" },
      { kind: "run", role: BG, resume: true },
      false,
    ),
  ).toMatchObject({
    source: "owner",
    rationaleCode: "RESUME",
    candidateAgentId: BG,
  });
  expect(settleRouting(base, { kind: "steer", role: BG }, { kind: "reply" }, true)).toMatchObject({
    source: "owner",
    rationaleCode: "CONTEXT_CONTINUATION",
  });
  expect(settleRouting(base, { kind: "run", role: FG }, { kind: "run", role: FG }, false)).toBe(
    base,
  );
});

test("jev pick of a background role right after an answering turn opens the task (no discussion guard)", async () => {
  const pick = proposer({ kind: "pick", role: BG, alternatives: [] }).impl;
  const deps: IntentDeps = {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: pick,
  };
  const after = await decideRoute(input(afterTurn(FG), VAGUE, { state: "done" }), deps);
  expect(after.decision).toEqual({ kind: "role", role: BG, scope: "new" });
  // A new thread (no answering turn before) has nothing to confirm.
  const fresh = await decideRoute(input(makeEnv(), VAGUE), deps);
  expect(fresh.decision).toEqual({ kind: "role", role: BG, scope: "new" });
});
