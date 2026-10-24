import type { CoreLimits } from "../config-defaults";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { outcomeKey, returnOutcome } from "./outcome-outbox";
import { settleSteering } from "./run-continuation";
import { HOLD_UNTIL } from "./run-create";
import { holdOrContinue } from "./run-steering";

/** Rows read per batch. */
const BATCH = 100;

/**
 * How an ended run's status maps to what `settleSteering` knows: a clean end is `done`, a restart cut is
 * `interrupted`, every other end (failed, blocked by a cap, dropped, expired, cancelled by Stop) is a failure.
 */
const SETTLE_AS = {
  done: "done",
  failed: "failed",
  blocked: "failed",
  dropped: "failed",
  expired: "failed",
  cancelled: "failed",
  interrupted: "interrupted",
} as const;

/** What the reconciler remembers between passes. */
export interface ReconcileState {
  /** `scope|first held row id` of scopes whose continuation a cap refused: not retried until that row changes. */
  stuck: Set<string>;
}

/**
 * Read a list in batches of `BATCH` (the cursor moves past every row read) and run `fn` for each row. A row
 * that throws is logged and skipped: it stays in the store, is tried again in the next pass, and never blocks
 * the rows behind it.
 */
async function forEachBatch<C, T>(
  ctx: HubContext,
  fetch: (after?: C) => Promise<T[]>,
  cursorOf: (t: T) => C,
  fn: (t: T) => Promise<void>,
): Promise<void> {
  let after: C | undefined;
  for (;;) {
    const batch = await fetch(after);
    for (const t of batch) {
      try {
        await fn(t);
      } catch (err) {
        ctx.deps.log?.error({ error: errText(err) }, "hub.reconcile_row_failed");
      }
    }
    const last = batch.at(-1);
    if (!last || batch.length < BATCH) return;
    after = cursorOf(last);
  }
}

/** The cursor of a wake list. */
const wakeCursor = (w: WakeRow) => ({ createdAt: w.createdAt, id: w.id });

/** (a) Runs stored but never released (a crash before the cap check): run the check, then release or block. */
async function releaseStaleHeld(ctx: HubContext): Promise<void> {
  const { store, clock } = ctx.deps;
  const before = clock.now() - ctx.limits.reconcileMs;
  await forEachBatch(
    ctx,
    (after) => store.wakes.staleHeld(HOLD_UNTIL, before, BATCH, after),
    wakeCursor,
    async (row) => {
      const bot = await store.bots.get(row.targetBot);
      if (!bot) return void (await ctx.wakeLog.dropped(row.id));
      const isOutcome = row.parentWakeId && row.dedupeKey === outcomeKey(row.parentWakeId);
      await ctx.admit(row, bot, {
        ...((isOutcome || row.hop > ctx.limits.maxHops) && { exemptFromHops: true }),
      });
    },
  );
}

/** (b) Steering rows bound to an ended run (the process died before its finish settled them). */
async function settleEndedRuns(ctx: HubContext): Promise<void> {
  const { store } = ctx.deps;
  await forEachBatch(
    ctx,
    (after) => store.steering.endedRuns(BATCH, after),
    (id: string) => id,
    async (id) => {
      const run = await store.wakes.get(id);
      const as = run && SETTLE_AS[run.status as keyof typeof SETTLE_AS];
      if (run && as) await settleSteering(ctx, run, as);
    },
  );
}

/**
 * (c) Held steering rows in a scope with no open run: nobody will hand them on. `holdOrContinue` creates the
 * continuation; when a cap refuses it (it logs once), the scope is left alone until its first held row changes
 * or a run finishes there (that finish retries by itself). The key names the first row and the time, so a
 * continuation that already ended under the plain key does not make the call a no-op.
 */
async function continueHeldScopes(ctx: HubContext, state: ReconcileState): Promise<void> {
  const { store, clock } = ctx.deps;
  await forEachBatch(
    ctx,
    (after) => store.steering.heldScopes(BATCH, after),
    (scope: string) => scope,
    async (scope) => {
      if ((await store.wakes.activeInScope(scope)).length > 0) return;
      const first = (await store.steering.held(scope))[0];
      if (!first || state.stuck.has(`${scope}|${first.id}`)) return;
      await holdOrContinue(ctx, scope, `${first.id}@${clock.now()}`);
      if ((await store.steering.held(scope))[0]?.id === first.id)
        state.stuck.add(`${scope}|${first.id}`);
    },
  );
}

/** (d) Finished runs whose result or failure was never returned to their sender. */
async function returnPendingOutcomes(ctx: HubContext): Promise<void> {
  await forEachBatch(
    ctx,
    (after) => ctx.deps.store.wakes.pendingOutcomes(BATCH, after),
    wakeCursor,
    async (row) => void (await returnOutcome(ctx, row)),
  );
}

/** One reconcile pass: the four repairs in order; a failing repair is logged and the next one still runs. */
export async function reconcileOnce(ctx: HubContext, state: ReconcileState): Promise<void> {
  const steps = [
    releaseStaleHeld,
    settleEndedRuns,
    (c: HubContext) => continueHeldScopes(c, state),
    returnPendingOutcomes,
  ];
  for (const step of steps) {
    try {
      await step(ctx);
    } catch (err) {
      ctx.deps.log?.error({ error: errText(err) }, "hub.reconcile_failed");
    }
  }
}

/**
 * Main process only: reconcile once now and then every `limits.reconcileMs` (the next timer is set when a
 * pass ends, so passes never overlap; a guard also refuses a second pass started from outside). Every repair
 * is idempotent, so it is safe next to the live finish paths and after any crash. Returns the stop function.
 */
export function startOutcomeReconciler(ctx: HubContext, limits: CoreLimits): () => void {
  const state: ReconcileState = { stuck: new Set() };
  let stopped = false;
  let running = false;
  let cancel = () => {};
  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await reconcileOnce(ctx, state);
    } finally {
      running = false;
    }
  };
  const next = () => {
    cancel = ctx.deps.clock.setTimer(limits.reconcileMs, () => {
      void pass().finally(() => !stopped && next());
    });
  };
  void pass().finally(() => !stopped && next());
  return () => {
    stopped = true;
    cancel();
  };
}
