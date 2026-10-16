import { registerRun } from "../src/orchestrator/run/live-runs";

/* Test helper: a steered run must be registered in the live-run registry before its sink attaches (as the detached
   runner does in production). Every registration is remembered so a test file can settle them in `afterEach`. */

const settles: (() => void)[] = [];

/** Register a live worker run of `turnId` (and of `taskId` when given) in `threadId`; returns its controller. */
export function liveWorker(turnId: string, threadId = "th", taskId?: string): AbortController {
  const ac = new AbortController();
  settles.push(registerRun({ kind: "worker", threadId, role: "developer", ac, turnId, taskId }));
  return ac;
}

/** Settle every run registered through `liveWorker` (call in `afterEach`). */
export function settleAllLive(): void {
  for (const s of settles.splice(0)) s();
}
