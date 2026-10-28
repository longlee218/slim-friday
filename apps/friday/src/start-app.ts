import { revokeControlLinks } from "@friday/api";
import { WriteThroughMemory } from "@friday/tools";
import type { AppDeps } from "./app-deps";
import { composeEngine } from "./compose-engine";
import { watchOwnerControl } from "./computer-owner-watch";
import { watchConfigReload } from "./config-reload";
import { startDailyMaintenance } from "./daily-maintenance";
import { startIdleSweep } from "./idle-sweep";
import { startUploadSweeper } from "./lifecycle/upload-sweeper";
import { scheduleChangeHook } from "./schedules/schedule-change-hook";
import { startScheduleTicker } from "./schedules/schedule-ticker";
import { showOpenCards } from "./show-open-cards";
import { conversationSync } from "./sync-conversations";
import { systemClock } from "./system-clock";
import { type MainWorkers, mainWorkers } from "./workers/main-workers";

export type { AppDeps, RuntimeParts } from "./app-deps";

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Compose the engine: config files, db, permission gate and bot hub over the given surface. Conversations of older
 * builds are deleted; every bot and group gets its fixed conversation; a change in the config dir is picked up
 * without a restart (changed bots restart with a fresh session, new bots and groups get conversations).
 * Returns the parts and `stop()`. A failed start closes everything it opened (the given engine db too) and rethrows.
 */
export async function startApp(deps: AppDeps) {
  /** Closers of what the start has opened so far; run newest first when it fails. */
  const opened: Array<() => unknown> = [];
  if (deps.engine) {
    const given = deps.engine;
    opened.push(() => given.close());
  }
  try {
    return await composeApp(deps, opened);
  } catch (err) {
    for (const close of opened.reverse()) {
      try {
        await close();
      } catch (e) {
        deps.log.error({ error: why(e) }, "app.start.cleanup");
      }
    }
    throw err;
  }
}

/** The body of `startApp`; pushes a closer to `opened` for every resource it opens. */
async function composeApp(deps: AppDeps, opened: Array<() => unknown>) {
  const { surface, log } = deps;
  // Worker processes run the runs when a launcher is given and `limits.workers` > 0; else this process does.
  let workers: MainWorkers | undefined;
  // The hub is built before the ticker: it fires this hook; the ticker and the caller's listener subscribe.
  const scheduleChanged = scheduleChangeHook();
  if (deps.onScheduleChange) scheduleChanged.subscribe(deps.onScheduleChange);
  const parts = composeEngine(
    {
      ...deps,
      onScheduleChange: scheduleChanged.fire,
      hubRuns: (config) => {
        const count: number = config.limits().workers;
        if (!deps.workers || count === 0) return {};
        workers = mainWorkers({
          count,
          launcher: deps.workers,
          log,
          clock: deps.clock ?? systemClock,
        });
        return { hints: workers.hints };
      },
    },
    opened,
  );
  const { config, engine, store, mem, memory, clock, hub: botHub, queue, known, postFlush } = parts;
  botHub.start();
  opened.push(() => botHub.stopAll());
  // An owner hold that ended (given back, or lapsed with the owner gone) closes its control sockets and resumes
  // the bots it turned away.
  opened.push(
    watchOwnerControl({
      holds: store.computerHolds,
      clock,
      onEnded: async (computer) => {
        revokeControlLinks(computer, clock.now());
        await parts.computers.resumeAfterGiveBack(computer);
      },
    }),
  );

  const { run, sync } = conversationSync({
    engine,
    surface,
    clock,
    log,
    bots: () => store.bots.list(),
    groups: () => config.listGroups(),
  });
  // Conversations keyed by the chat app of older builds go first; then the first sync must work.
  const n = await engine.conversations.deleteLegacy();
  if (n > 0) log.info({ n }, "conversations.legacy_deleted");
  await run();

  // Cards are rows: the open ones the last run left are shown again (their runs stay parked until answered).
  await showOpenCards(store, surface).catch((err) => log.error({ error: why(err) }, "cards.show"));

  // Put back the wakes the last run left open (after the first sync, which creates the conversations they answer in).
  await botHub.recover().catch((err) => log.error({ error: why(err) }, "wakes.recover"));
  // The workers start once the rows of the last boot are checked; main stops them before it closes the db.
  if (workers) {
    const pool = workers;
    pool.start({
      surface,
      store,
      ...(deps.onTicketChange && { onTicketChange: deps.onTicketChange }),
      // A schedule a worker's bot changed: main's ticker looks now, the web is told.
      onScheduleChange: scheduleChanged.fire,
    });
    opened.push(() => pool.stop());
  }

  const stopWatching = watchConfigReload({
    config,
    hub: botHub,
    store,
    sync,
    log,
    onConfigChanged: deps.onConfigChanged,
  });

  let stopped = false;
  const stopIdleSweep = startIdleSweep(botHub, clock, log);
  const ticker = startScheduleTicker(botHub.schedules, clock, log);
  scheduleChanged.subscribe(ticker.kick);
  const stopReconciler = botHub.startReconciler();
  const stopUploadSweeper = startUploadSweeper(engine, deps.files, log, () => clock.now());
  const daily = startDailyMaintenance({
    ...mem,
    engine,
    store,
    clock,
    log,
    ...(deps.consolidate && { consolidate: deps.consolidate }),
    queue,
    known,
    finishedWakeKeepMs: config.limits().finishedWakeKeepMs,
  });

  return {
    hub: botHub,
    config,
    /** The app's memory files (the settings admins write through it, so the index follows). */
    memory,
    /** The composed store (engine db + config bots and groups), for the web API. */
    store,
    /** The worker pool; unset in in-process mode. */
    workers,
    /** The computers of this process, for the web API. */
    computers: parts.computers,
    /** Settles when the first consolidation, prune and message catch-up are done (tests wait on it). */
    memoryReady: daily.ready,
    /** Stop watching and sweeping, stop every session, close the dbs (open cards are the caller's to cancel). */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Started first: it gives up a consolidation still waiting on the model.
      const dailyDone = daily.stop();
      // Same for a post-flush consolidation; started runs settle before the memory and the dbs close.
      const postFlushDone = postFlush?.stop();
      // Workers requeue their runs and exit (in parallel with the rest) before the db closes.
      const workersDone = workers?.stop();
      stopWatching();
      stopIdleSweep();
      const tickerDone = ticker.stop();
      await stopReconciler();
      stopUploadSweeper();
      await workersDone;
      await tickerDone;
      // In-process mode: this process's runs are requeued here (a run that ignores its stop is not waited for).
      if (!(await botHub.stopAll(10_000))) log.warn({}, "app.runs_unsettled");
      // A daily run may still use the index and the db.
      await dailyDone;
      await postFlushDone;
      if (memory instanceof WriteThroughMemory) await memory.stop();
      mem.memoryIndex.close();
      engine.close();
    },
  };
}
