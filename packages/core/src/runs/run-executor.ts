import type { WakeRow } from "../domain/wake";
import { returnOutcome } from "../hub/bot-messaging";
import type { HubContext } from "../hub/hub-context";
import { type SessionScope, sessionScope } from "../hub/session-scope";
import { checkUnfinished } from "../hub/ticket-wakes";
import { abortRun, newRunExec, type RunExec } from "./run-exec";
import { countCut, handleRunError } from "./run-failure";
import { finishRun } from "./run-finish";
import type { RunLease } from "./run-lease";
import { type PumpEnd, pumpRun } from "./run-pump";
import { openRunSession } from "./run-session";
import { persistEffort, runSpec } from "./run-spec";
import { buildRunTurn } from "./run-turn";

/**
 * Execute one claimed run (already `running`, lease held): one agent session turn. Count a cut when the row
 * was reclaimed from `running`, set the taint flag, show "typing" before the session opens, open (resume) the
 * scope's session, push the turn, pump its events until the turn and every background task with its follow-up
 * turn ended, close the session, then finish or apply the failure rules. A lost lease aborts the session and
 * writes no finish (the fence would refuse it anyway).
 */
export async function executeRun(ctx: HubContext, row: WakeRow, lease: RunLease): Promise<void> {
  const { store, clock, surface } = ctx.deps;
  const fence = lease.fence;
  const scope = await scopeOf(ctx, row);
  if (!scope) return dropRun(ctx, row, fence);
  const claimed = await countCut(ctx, row, fence, scope.bot);
  if (!claimed) return;
  // Spec "Taint flag": not started by the owner, resumes a cut or parked run, or a second attempt.
  const tainted =
    claimed.sender.kind !== "user" || claimed.cuts > 0 || claimed.cardId !== undefined || fence > 1;
  const patch = { attempts: Math.max(claimed.attempts, fence), ...(tainted && { tainted }) };
  if (!(await store.wakes.transition(row.id, fence, ["running"], patch))) return;
  const now = clock.now();
  ctx.wakeLog.logStarted(claimed, now);
  // The working sign does not wait for the session to start.
  surface.showActivity(row.conversationId, { kind: "typing", botId: scope.bot.id });
  const exec = newRunExec({ ...claimed, ...patch }, scope, now, tainted);
  ctx.runs.set(exec.key, exec);
  lease.listen((why) => abortRun(exec, { kind: "lease", why }));
  if (ctx.closing) abortRun(exec, { kind: "shutdown" });
  try {
    const end = await runSession(ctx, exec, scope);
    // The session closes before the finish is written: no tool acts after the run ended.
    exec.live = false;
    await exec.session?.stop().catch(() => {});
    if (ctx.runs.get(exec.key) === exec) ctx.runs.delete(exec.key);
    await settle(ctx, exec, end);
  } finally {
    exec.live = false;
    if (ctx.runs.get(exec.key) === exec) ctx.runs.delete(exec.key);
    exec.markEnded();
  }
}

/** Open the session, push the turn and pump its events; any throw becomes an error end. */
async function runSession(ctx: HubContext, exec: RunExec, scope: SessionScope): Promise<PumpEnd> {
  try {
    const state = await ctx.deps.store.scopes.get(exec.key);
    const spec = runSpec(ctx, exec, state?.effort);
    const opened = await openRunSession({ ...ctx.deps, limits: ctx.limits }, scope, spec);
    exec.session = opened.session;
    persistEffort(ctx, exec.key, spec);
    if (exec.stop) return { kind: "stopped" };
    const turn = await buildRunTurn(ctx, exec.row, {
      cut: exec.row.cuts > 0,
      shown: opened.memory,
    });
    if (exec.stop) return { kind: "stopped" };
    exec.turnOpen = true;
    exec.session.send(turn);
    return await pumpRun(ctx, exec);
  } catch (err) {
    return exec.stop ? { kind: "stopped" } : { kind: "error", err };
  }
}

/** Store how the run ended: finished, failed with the retry rules, or cut short. */
async function settle(ctx: HubContext, exec: RunExec, end: PumpEnd): Promise<void> {
  const { row, bot } = exec;
  const fence = row.leaseFence;
  if (end.kind === "error") return handleRunError(ctx, row, fence, end.err, bot);
  if (end.kind === "stopped" && exec.stop?.kind !== "idle") return cutShort(ctx, exec);
  // Silent while only a finished task's follow-up turn was still to come: the work is done.
  const idleAfterTurn = end.kind === "stopped" && !exec.turnOpen && exec.tasks.size === 0;
  if (end.kind === "stopped" && !idleAfterTurn) {
    const err = Object.assign(new Error("model stream idle timeout"), { retryable: true });
    return handleRunError(ctx, row, fence, err, bot);
  }
  const resultText = exec.turnTexts.at(-1);
  const done = { status: "done" as const, ...(resultText !== undefined && { resultText }) };
  if (!(await finishRun(ctx, row, fence, done))) return;
  await returnOutcome(ctx, exec);
  await checkUnfinished(ctx, exec);
}

/**
 * A run cut short by the owner's stop (`cancelled`), a lost lease or a shutdown. Only a stop changes the row;
 * after a lost lease another worker owns it, and after a shutdown the next boot reclaims it with a cut.
 */
async function cutShort(ctx: HubContext, exec: RunExec): Promise<void> {
  const { store, clock } = ctx.deps;
  const { row } = exec;
  const now = clock.now();
  if (exec.stop?.kind === "stopped") {
    const patch = { status: "cancelled" as const, endedAt: now };
    if (!(await store.wakes.transition(row.id, row.leaseFence, ["running"], patch))) return;
    await store.scopes.finished(row.scopeKey, now);
  }
  await store.attempts.finish(`${row.id}:${row.leaseFence}`, "interrupted", now);
}

/** The session scope of a run; undefined when its bot, conversation or group membership is gone. */
async function scopeOf(ctx: HubContext, row: WakeRow): Promise<SessionScope | undefined> {
  const { store } = ctx.deps;
  const bot = await store.bots.get(row.targetBot);
  const conv = await store.conversations.get(row.conversationId);
  if (!bot || !conv) return undefined;
  const group = conv.kind === "group" ? await store.groups.get(conv.groupId) : undefined;
  return sessionScope(bot, conv, group, ctx.deps.scopeBot);
}

/** A run whose bot or conversation is gone: kept on record as dropped. */
async function dropRun(ctx: HubContext, row: WakeRow, fence: number): Promise<void> {
  const { store, clock, log } = ctx.deps;
  const now = clock.now();
  const patch = { status: "dropped" as const, endedAt: now };
  if (!(await store.wakes.transition(row.id, fence, ["running"], patch))) return;
  await store.attempts.finish(`${row.id}:${fence}`, "failed", now, "bot or conversation gone");
  log?.warn({ event: "wake.dropped", wakeId: row.id, botId: row.targetBot }, "wake.dropped");
}
