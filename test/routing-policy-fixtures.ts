import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentClassifier, IntentInput, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { logger } from "../src/observability/logger";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { ROLES } from "../src/roles/role-registry";
import type { RouteProposal, RouteProposer } from "../src/intent/jev/route-proposer";
import type { RouteInput } from "../src/routing/routing-policy";
import { activeOwnedTask } from "../src/storage/owned-task-store";
import { finishTurn, interruptRunningTurns } from "../src/storage/run-store";
import { settleTaskAfterTurn } from "../src/tasks/task-resolver";
import { makeEnv } from "./helpers";

export const pipeline = {
  lexicon: loadLexicon(),
  tagRouter: createRoleTagRouter(Object.values(ROLES)),
};
export const BG = Object.values(ROLES).find((r) => r.background)!.name;
export const FG = Object.values(ROLES).find((r) => !r.background)!.name;
export const tagOf = (role: string) => ROLES[role]!.tag!;
export const verdict = (o: Partial<IntentResult> = {}): IntentResult => ({
  role: FG,
  scope: "new",
  confidence: "high",
  reason: "r",
  ...o,
});

/** Fake Haiku L3 that counts calls; an Error result throws. */
export function haiku(result: IntentResult | Error = verdict()) {
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

/** Fake proposer that counts calls. */
export function proposer(p: RouteProposal | Error) {
  const calls: unknown[] = [];
  const impl: RouteProposer = {
    propose: async (i) => {
      calls.push(i);
      if (p instanceof Error) throw p;
      return p;
    },
  };
  return { impl, calls };
}

/** A thread `th` whose background task was interrupted: its owned task waits for the owner (idle thread, no question). */
export function waitingTask() {
  const env = makeEnv();
  beginTurn(
    env.db,
    logger,
    { turnId: "t1", threadId: "th", source: "t" },
    { location: "r", role: BG },
  );
  interruptRunningTurns(env.db);
  return { ...env, task: activeOwnedTask(env.db, "th")! };
}

export const input = (
  env: ReturnType<typeof waitingTask> | ReturnType<typeof makeEnv>,
  text: string,
  over: Partial<RouteInput> = {},
): RouteInput => ({
  db: env.db,
  log: logger,
  threadId: "th",
  text,
  state: "idle",
  hasTask: false,
  busy: false,
  active: activeOwnedTask(env.db, "th"),
  l3Input: () => ({ text, thread: { state: "idle" }, ledger: [], recent: [], roles: [] }),
  ...over,
});
export const VAGUE = "can you look at the auth thing";

/** A thread whose last turn was `role` (finished, task completed). */
export function afterTurn(role: string) {
  const env = makeEnv();
  beginTurn(env.db, logger, { turnId: "t1", threadId: "th", source: "t" }, { location: "r", role });
  finishTurn(env.db, "t1", "done");
  settleTaskAfterTurn(env.db, "t1", "done");
  return env;
}
export const failing: IntentDeps = {
  pipeline,
  classifier: haiku(new Error("down")).classifier,
  engine: "jev",
};
