import type { Bot } from "../domain/bot";
import type { WakeRow } from "../domain/wake";
import { type HubContext, tell } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { finishRun } from "./run-finish";
import { backoffMs, classifyFailure } from "./run-rules";

/** What the owner is told when a run gives up. */
export const GIVE_UP_TEXT = "Send a message to continue.";

/** `transient` (retry), `setup` (retry, counted apart) or `fatal`; a runtime error marked `retryable` is transient. */
export function failureKind(err: unknown): "transient" | "setup" | "fatal" {
  const retryable = typeof err === "object" && err !== null && "retryable" in err && err.retryable;
  return retryable === true ? "transient" : classifyFailure(err);
}

/**
 * A run failed in this worker. `transient`: back to `queued` with `transientRetries + 1` and `wakeAt = now +
 * backoffMs(n)`; past `limits.transientRetries` it ends `failed` and the conversation is told
 * "Send a message to continue.". `setup`: the same with `setupFailures`, failed at the `setupFailures`-th.
 * `fatal`: failed at once. Every write is fenced; a lost fence writes nothing more.
 */
export async function handleRunError(
  ctx: HubContext,
  row: WakeRow,
  fence: number,
  err: unknown,
  bot: Pick<Bot, "name">,
): Promise<void> {
  const { store, clock, log } = ctx.deps;
  const kind = failureKind(err);
  const why = errText(err);
  const id = `${row.id}:${fence}`;
  log?.warn({ wakeId: row.id, kind, error: why }, "run.failed_attempt");
  const retry =
    kind === "transient"
      ? { field: "transientRetries" as const, n: row.transientRetries + 1 }
      : kind === "setup"
        ? { field: "setupFailures" as const, n: row.setupFailures + 1 }
        : undefined;
  const canRetry =
    retry &&
    (retry.field === "transientRetries"
      ? retry.n <= ctx.limits.transientRetries
      : retry.n < ctx.limits.setupFailures);
  if (retry && canRetry) {
    const now = clock.now();
    const patch = {
      status: "queued" as const,
      [retry.field]: retry.n,
      wakeAt: now + backoffMs(retry.n),
    };
    if (!(await store.wakes.transition(row.id, fence, ["running"], patch))) return;
    await store.attempts.finish(id, kind === "setup" ? "setup_failed" : "failed", now, why);
    return;
  }
  const failed = retry ? { [retry.field]: retry.n } : {};
  if (retry) await store.wakes.transition(row.id, fence, ["running"], failed);
  if (!(await finishRun(ctx, row, fence, { status: "failed", error: why }))) return;
  const text =
    kind === "fatal"
      ? `${bot.name} stopped unexpectedly: ${why}. ${GIVE_UP_TEXT}`
      : `${bot.name} could not finish: ${why}. ${GIVE_UP_TEXT}`;
  await tell(ctx, row.conversationId, text);
}

/**
 * Claim of a row that was `running` (its worker died or its lease ran out): one more cut. Below
 * `limits.cutAttempts` the run goes on with the cut note (the returned row has the new `cuts`); at the limit it
 * ends `interrupted`, the conversation is told and undefined is returned. The attempt the dead worker left open
 * is closed `interrupted` for any reclaimed row.
 */
export async function countCut(
  ctx: HubContext,
  row: WakeRow,
  fence: number,
  bot: Pick<Bot, "name">,
): Promise<WakeRow | undefined> {
  const { store, clock } = ctx.deps;
  const now = clock.now();
  if (row.claimedFrom === "leased" || row.claimedFrom === "running")
    await store.attempts.finish(`${row.id}:${fence - 1}`, "interrupted", now);
  if (row.claimedFrom !== "running") return row;
  const cuts = row.cuts + 1;
  if (cuts < ctx.limits.cutAttempts) {
    if (!(await store.wakes.transition(row.id, fence, ["running"], { cuts }))) return undefined;
    return { ...row, cuts };
  }
  const patch = { status: "interrupted" as const, cuts, endedAt: now };
  if (!(await store.wakes.transition(row.id, fence, ["running"], patch))) return undefined;
  await store.attempts.finish(`${row.id}:${fence}`, "interrupted", now);
  await store.scopes.finished(row.scopeKey, now, Math.max(0, row.createdAt - 1));
  ctx.deps.log?.warn({ event: "wake.interrupted", wakeId: row.id, cuts }, "wake.interrupted");
  await tell(
    ctx,
    row.conversationId,
    `${bot.name} was interrupted ${cuts} times by restarts; the message was not delivered again.`,
  );
  return undefined;
}
