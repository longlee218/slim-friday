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

/** Conversation ids that have a live-run cache entry. */
function runConversations(qc: QueryClient): string[] {
  return qc
    .getQueryCache()
    .findAll({ queryKey: ["web", "liveRun"] })
    .map((q) => q.queryKey[2] as string);
}

/**
 * Ends every run whose bot is not in `working`. The status list names only bots with an open
 * session, so a stopped or lost session (absent from the list) ends its runs too.
 */
export function endRunsExcept(qc: QueryClient, working: ReadonlySet<string>) {
  for (const id of runConversations(qc)) {
    const runs = qc.getQueryData<Runs>(liveRunKey(id)) ?? {};
    if (Object.keys(runs).every((botId) => working.has(botId))) continue;
    patchRuns(qc, id, (r) => Object.fromEntries(Object.entries(r).filter(([b]) => working.has(b))));
  }
}

/** Drops every live run (resync or a gap of unknown length: the server state is the truth). */
export function clearRuns(qc: QueryClient) {
  qc.removeQueries({ queryKey: ["web", "liveRun"] });
}

/** Ends a bot's run; conversation "*" = every conversation that has a live run. */
export function endRun(qc: QueryClient, conversationId: string, botId: string) {
  const ids = conversationId === "*" ? runConversations(qc) : [conversationId];
  for (const id of ids) {
    patchRuns(qc, id, (r) => {
      const { [botId]: _gone, ...rest } = r;
      return rest;
    });
  }
}
