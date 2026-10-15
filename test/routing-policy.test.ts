import { expect, test } from "bun:test";
import type { RouteProposal } from "../src/intent/jev/route-proposer";
import { decideRoute } from "../src/routing/routing-policy";
import { makeEnv } from "./helpers";
import {
  BG,
  FG,
  haiku,
  input,
  pipeline,
  proposer,
  VAGUE,
  verdict,
  waitingTask,
} from "./routing-policy-fixtures";

test("jev: proposer `continue` on a waiting task -> owner continuation, no L3 call", async () => {
  const env = waitingTask();
  const h = haiku();
  const p = proposer({ kind: "continue", scores: { continueP: 0.9 } });
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
    proposer: p.impl,
  });
  expect(plan.decision).toMatchObject({ kind: "role", role: BG, scope: "active" });
  expect(plan.continueTask?.taskId).toBe(env.task.taskId);
  expect(plan.routing).toMatchObject({
    source: "owner",
    rationaleCode: "CONTEXT_CONTINUATION",
    taskId: env.task.taskId,
    candidateAgentId: BG,
  });
  expect(plan.extra.jev).toEqual({ continueP: 0.9 });
  expect(h.inputs).toHaveLength(0);
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]).toMatchObject({ task: { taskId: env.task.taskId, ownerRole: BG } });
});

test("jev: `continue` without a waiting task is not usable -> one Haiku call", async () => {
  const env = makeEnv();
  const h = haiku();
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
    proposer: proposer({ kind: "continue" }).impl,
  });
  expect(h.inputs).toHaveLength(1);
  expect(plan.continueTask).toBeUndefined();
  expect(plan.routing).toMatchObject({ source: "fallback", rationaleCode: "MODEL_FALLBACK" });
});

test("jev: undecided -> exactly one Haiku call that sees the waiting task as active; role == owner + scope active continues", async () => {
  const env = waitingTask();
  const h = haiku(verdict({ role: BG, scope: "active" }));
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
    proposer: proposer({ kind: "undecided", reason: "low_confidence" }).impl,
  });
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]!.thread.activeRole).toBe(BG);
  expect(plan.continueTask?.taskId).toBe(env.task.taskId);
  expect(plan.routing).toMatchObject({ source: "owner", rationaleCode: "CONTEXT_CONTINUATION" });
});

test("jev: Haiku picks another role -> MODEL_FALLBACK, task untouched", async () => {
  const env = waitingTask();
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: haiku(verdict({ role: FG })).classifier,
    engine: "jev",
    proposer: proposer({ kind: "undecided", reason: "unclear" }).impl,
  });
  expect(plan.continueTask).toBeUndefined();
  expect(plan.routing).toMatchObject({
    source: "fallback",
    rationaleCode: "MODEL_FALLBACK",
    candidateAgentId: FG,
  });
});

test("haiku (default engine): never continues; the owner candidate is logged in shadow; proposer unused", async () => {
  const env = waitingTask();
  const h = haiku(verdict({ role: BG, scope: "active" }));
  const p = proposer({ kind: "continue" });
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    proposer: p.impl,
  });
  expect(p.calls).toHaveLength(0);
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]!.thread.activeRole).toBeUndefined();
  expect(plan.continueTask).toBeUndefined();
  expect(plan.extra.ownerCandidate).toBe(env.task.taskId);
  expect(plan.routing.rationaleCode).toBe("MODEL_FALLBACK");
});

test("jev: pick -> source jev, JEV_MATCH, alternatives and ranking kept", async () => {
  const env = makeEnv();
  const h = haiku();
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
    proposer: proposer({
      kind: "pick",
      role: BG,
      alternatives: [FG],
      scores: { ranking: { [BG]: 0.9, [FG]: 0.05 } },
    }).impl,
  });
  expect(plan.decision).toMatchObject({ kind: "role", role: BG, scope: "new" });
  expect(plan.routing).toMatchObject({
    source: "jev",
    rationaleCode: "JEV_MATCH",
    alternatives: [FG],
  });
  expect(plan.ranking).toEqual({ [BG]: 0.9, [FG]: 0.05 });
  expect(h.inputs).toHaveLength(0);
});

test("jev: multi-intent -> one clarify question listing the roles", async () => {
  const env = makeEnv();
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: proposer({ kind: "multi", roles: [BG, FG] }).impl,
  });
  expect(plan.decision).toMatchObject({ kind: "ask" });
  expect((plan.decision as { text?: string }).text).toContain(BG);
  expect(plan.routing).toMatchObject({
    source: "clarify",
    rationaleCode: "AMBIGUOUS_INTENT",
    ambiguityFlags: ["multi_intent"],
    alternatives: [BG, FG],
  });
});

test("a pick of an unknown role, or a throwing proposer, falls back to Haiku", async () => {
  const bad: (RouteProposal | Error)[] = [
    { kind: "pick", role: "ghost", alternatives: [] },
    new Error("boom"),
  ];
  for (const p of bad) {
    const env = makeEnv();
    const h = haiku();
    await decideRoute(input(env, VAGUE), {
      pipeline,
      classifier: h.classifier,
      engine: "jev",
      proposer: proposer(p).impl,
    });
    expect(h.inputs).toHaveLength(1);
  }
});

test("engine jev without a proposer: Haiku decides (continuation by the fallback rule)", async () => {
  const env = waitingTask();
  const h = haiku(verdict({ role: BG, scope: "active" }));
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
  });
  expect(h.inputs).toHaveLength(1);
  expect(plan.continueTask?.taskId).toBe(env.task.taskId);
});

test("jev pick of the waiting owner's role without `continue` opens a NEW task of that role (intended)", async () => {
  const env = waitingTask();
  const plan = await decideRoute(input(env, VAGUE), {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: proposer({ kind: "pick", role: BG, alternatives: [] }).impl,
  });
  expect(plan.decision).toMatchObject({ kind: "role", role: BG, scope: "new" });
  expect(plan.continueTask).toBeUndefined();
  expect(plan.routing).toMatchObject({ source: "jev", rationaleCode: "JEV_MATCH" });
});
