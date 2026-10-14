import { expect, test } from "bun:test";
import type { IntentDeps } from "../src/intent/decide-intent";
import { logger } from "../src/observability/logger";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { decideRoute } from "../src/routing/routing-policy";
import { activeOwnedTask, getOwnedTask } from "../src/storage/owned-task-store";
import { makeEnv } from "./helpers";
import {
  afterTurn,
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

test("a pending question or a busy thread bypasses the proposer and the owner", async () => {
  const env = waitingTask();
  const p = proposer({ kind: "continue" });
  const deps: IntentDeps = {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: p.impl,
  };
  const pending = await decideRoute(input(env, VAGUE, { pendingQuestion: "Run it?" }), deps);
  const busy = await decideRoute(input(env, VAGUE, { busy: true, state: "running" }), deps);
  expect(p.calls).toHaveLength(0);
  expect(pending.continueTask).toBeUndefined();
  expect(busy.continueTask).toBeUndefined();
});

test("continuation only for an open or waiting task: a running or completed task is never continued", async () => {
  const running = makeEnv();
  beginTurn(
    running.db,
    logger,
    { turnId: "t1", threadId: "th", source: "t" },
    { location: "r", role: BG },
  );
  const runningTask = activeOwnedTask(running.db, "th")!;
  expect(runningTask.status).toBe("running");
  const p = proposer({ kind: "continue" });
  const onRunning = await decideRoute(input(running, VAGUE, { active: runningTask }), {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: p.impl,
  });
  expect(onRunning.continueTask).toBeUndefined();
  expect(onRunning.routing.source).not.toBe("owner");

  const done = afterTurn(BG);
  const taskId = done.db.query<{ id: string }, []>("SELECT id FROM owned_tasks").get()!.id;
  const completed = getOwnedTask(done.db, taskId)!;
  expect(completed.status).toBe("completed");
  const onCompleted = await decideRoute(input(done, VAGUE, { state: "done", active: completed }), {
    pipeline,
    classifier: haiku().classifier,
    engine: "jev",
    proposer: p.impl,
  });
  expect(onCompleted.continueTask).toBeUndefined();
  expect(onCompleted.routing.rationaleCode).not.toBe("CONTEXT_CONTINUATION");
});

test("busy steer still routes: a running task takes the message as its steer (L3 scope), no proposer", async () => {
  const env = makeEnv();
  beginTurn(
    env.db,
    logger,
    { turnId: "t1", threadId: "th", source: "t" },
    { location: "r", role: BG },
  );
  const h = haiku(verdict({ role: BG, scope: "active" }));
  const p = proposer({ kind: "continue" });
  const plan = await decideRoute(
    input(env, "also add the retry case", { busy: true, state: "running", hasTask: true }),
    { pipeline, classifier: h.classifier, engine: "jev", proposer: p.impl },
  );
  expect(p.calls).toHaveLength(0);
  expect(h.inputs).toHaveLength(1);
  expect(plan.decision).toMatchObject({ kind: "role", role: BG, scope: "active" });
  expect(plan.continueTask).toBeUndefined();
  expect(plan.routing.source).toBe("fallback");
});

test("pending question: the decision is the same as without Jev (L3 answers), the proposer is never asked", async () => {
  const env = waitingTask();
  const h = haiku(verdict({ role: FG, scope: "new" }));
  const p = proposer({ kind: "continue" });
  const withJev = await decideRoute(input(env, "yes", { pendingQuestion: "Run it?" }), {
    pipeline,
    classifier: h.classifier,
    engine: "jev",
    proposer: p.impl,
  });
  const withHaiku = await decideRoute(input(env, "yes", { pendingQuestion: "Run it?" }), {
    pipeline,
    classifier: h.classifier,
  });
  expect(p.calls).toHaveLength(0);
  expect(h.inputs).toHaveLength(2);
  expect(withJev.decision).toEqual(withHaiku.decision);
  expect(withJev.continueTask).toBeUndefined();
});
