import type { FileStore, Log, Store, UploadRow } from "@friday/core";

/** A pending upload older than this is deleted with its R2 object (spec: 1 day). */
const PENDING_TTL_MS = 86_400_000;
/**
 * A claimed upload is held by a send in progress; only one older than this is swept. `pendingBefore` returns stale
 * claimed rows too, and a send never takes this long, so a 2-day-old claim is one a crash left behind.
 */
const CLAIMED_TTL_MS = 2 * 86_400_000;
/** How often the sweeper runs after the start sweep. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Delete every unused upload older than a day (a claimed one: older than two days): the R2 object first, then the
 * row. A failed object delete keeps the row, so the next sweep retries it; it is logged. An upload whose key a
 * `files` row holds is kept: a send stored the message but died before marking it used (its replay marks it).
 * Returns the rows deleted.
 */
export async function sweepUploads(
  store: Pick<Store, "uploads" | "files">,
  files: FileStore,
  now: number,
  log: Log,
): Promise<number> {
  /** Old enough to go: unused, and a claim (a send in progress) only after two days. */
  const sweepable = (u: UploadRow | undefined): u is UploadRow =>
    !!u &&
    u.at < now - PENDING_TTL_MS &&
    (u.state === "pending" || (u.state === "claimed" && u.at < now - CLAIMED_TTL_MS));
  let removed = 0;
  for (const listed of await store.uploads.pendingBefore(now - PENDING_TTL_MS)) {
    try {
      // Read again just before deleting: a send may have claimed or used the upload since the list was read.
      const u = await store.uploads.get(listed.id);
      if (!sweepable(u) || (await store.files.hasKey(u.key))) continue;
      await files.delete(u.key);
      await store.uploads.delete(u.id);
      removed++;
    } catch (err) {
      log.error({ uploadId: listed.id, error: why(err) }, "uploads.sweep");
    }
  }
  if (removed) log.info({ removed }, "uploads.swept");
  return removed;
}

/** Sweep now and every 6 hours; the timer never keeps the process alive. Returns the stop function. */
export function startUploadSweeper(
  store: Pick<Store, "uploads" | "files">,
  files: FileStore,
  log: Log,
  now: () => number = Date.now,
): () => void {
  const run = () =>
    void sweepUploads(store, files, now(), log).catch((err) =>
      log.error({ error: why(err) }, "uploads.sweep"),
    );
  run();
  const timer = setInterval(run, SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
