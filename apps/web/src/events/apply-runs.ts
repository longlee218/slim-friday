import type { RunStepDto } from "@friday/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { type LiveRun, liveRunKey } from "./client-keys";

type Runs = Record<string, LiveRun>;

/** Applies `fn` to a conversation's live runs (an empty record means no run; undefined would be a no-op). */
function patchRuns(qc: QueryClient, conversationId: string, fn: (runs: Runs) => Runs): void {
  qc.setQueryData<Runs>(liveRunKey(conversationId), (runs) => fn(runs ?? {}));
}

/** Opens a live run unless the bot already has one. */
export function startRun(qc: QueryClient, conversationId: string, botId: string, at: number) {
  patchRuns(qc, conversationId, (r) =>
    r[botId] ? r : { ...r, [botId]: { botId, startedAt: at, steps: [] } },
  );
}

/** Replaces the step with the same id or appends it; creates the run from the step's start. */
export function runStep(qc: QueryClient, conversationId: string, botId: string, step: RunStepDto) {
  patchRuns(qc, conversationId, (r) => {
    const run = r[botId] ?? { botId, startedAt: step.startedAt, steps: [] };
    const has = run.steps.some((s) => s.id === step.id);
    const steps = has ? run.steps.map((s) => (s.id === step.id ? step : s)) : [...run.steps, step];
    return { ...r, [botId]: { ...run, steps } };
  });
}

/** Records the latest subagent label on the bot's run. */
export function runTail(qc: QueryClient, conversationId: string, botId: string, label: string) {
  patchRuns(qc, conversationId, (r) =>
    r[botId] ? { ...r, [botId]: { ...r[botId], tail: label } } : r,
  );
}

/** Ends a bot's run; conversation "*" = every conversation that has a live run. */
export function endRun(qc: QueryClient, conversationId: string, botId: string) {
  const ids =
    conversationId === "*"
      ? qc
          .getQueryCache()
          .findAll({ queryKey: ["web", "liveRun"] })
          .map((q) => q.queryKey[2] as string)
      : [conversationId];
  for (const id of ids) {
    patchRuns(qc, id, (r) => {
      const { [botId]: _gone, ...rest } = r;
      return rest;
    });
  }
}
