import type { RunStepDto } from "@friday/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { type LiveRun, liveRunKey } from "./client-keys";

type Runs = Record<string, LiveRun>;

/**
 * How long an unconfirmed (optimistic) run survives a status list that does not name its bot: the
 * bot's session may not exist yet when that status was read, so only an old one is stale.
 */
const UNCONFIRMED_GRACE_MS = 30_000;

/** Applies `fn` to a conversation's live runs (an empty record means no run; undefined would be a no-op). */
function patchRuns(qc: QueryClient, conversationId: string, fn: (runs: Runs) => Runs): void {
  qc.setQueryData<Runs>(liveRunKey(conversationId), (runs) => fn(runs ?? {}));
}

/**
 * Opens a live run unless the bot already has one. `confirmed` = a server event started it (an
 * existing optimistic run becomes confirmed, keeping its start).
 */
export function startRun(
  qc: QueryClient,
  conversationId: string,
  botId: string,
  at: number,
  confirmed = false,
) {
  patchRuns(qc, conversationId, (r) => {
    const run = r[botId];
    if (run) return confirmed && !run.confirmed ? { ...r, [botId]: { ...run, confirmed } } : r;
    return { ...r, [botId]: { botId, startedAt: at, steps: [], confirmed } };
  });
}

/** Replaces the step with the same id or appends it; creates the run from the step's start. */
export function runStep(qc: QueryClient, conversationId: string, botId: string, step: RunStepDto) {
  patchRuns(qc, conversationId, (r) => {
    const run = r[botId] ?? { botId, startedAt: step.startedAt, steps: [] };
    const has = run.steps.some((s) => s.id === step.id);
    const steps = has ? run.steps.map((s) => (s.id === step.id ? step : s)) : [...run.steps, step];
    return { ...r, [botId]: { ...run, steps, confirmed: true } };
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
 * session, so a stopped or lost session (absent from the list) ends its runs too. A young
 * unconfirmed run is kept: the status may predate the session the send is opening.
 */
export function endRunsExcept(qc: QueryClient, working: ReadonlySet<string>, now = Date.now()) {
  const keep = (run: LiveRun) =>
    working.has(run.botId) || (!run.confirmed && now - run.startedAt < UNCONFIRMED_GRACE_MS);
  for (const id of runConversations(qc)) {
    const runs = qc.getQueryData<Runs>(liveRunKey(id)) ?? {};
    if (Object.values(runs).every(keep)) continue;
    patchRuns(qc, id, (r) => Object.fromEntries(Object.entries(r).filter(([, run]) => keep(run))));
  }
}

/**
 * Drops every live run (resync or a gap of unknown length: the server state is the truth). Writes
 * an empty record rather than removing the queries, so chat views on screen re-render.
 */
export function clearRuns(qc: QueryClient) {
  for (const id of runConversations(qc)) qc.setQueryData<Runs>(liveRunKey(id), {});
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
