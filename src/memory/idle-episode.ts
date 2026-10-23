import type { Database } from "bun:sqlite";
import {
  EPISODE_IDLE_MS,
  EPISODE_INPUT_MAX_CHARS,
  EPISODE_MAX_PER_TICK,
} from "../config/memory-caps";
import { logEvent, logger } from "../observability/logger";
import { errText, redactText } from "../observability/redact";
import { EPISODE_SYSTEM } from "../roles/prompts/memory-prompts";
import { CHIEF_OF_STAFF } from "../roles/role-names";
import { type IdleThread, idleThreads, threadFacts } from "../storage/episode-store";
import {
  getThreadSummary,
  saveSummary,
  THREAD_SUMMARY_MAX_CHARS,
} from "../storage/thread-summary-store";
import { selectWorkspace } from "../workspaces/task-workspace";
import { indexSummary } from "./index/memory-index";
import { safely } from "./index/safely";
import type { CompactLlm } from "./memory-compaction-llm";

const log = logger.child({ module: "idle-episode" });

/** Workspace and channel (yaml names) of a Discord channel id; null = unmapped. */
export type ChannelResolver = (channelId: string) => { workspace: string; channel: string } | null;

/** Default resolver: the workspace registry (re-read per call, so a new channel works without a restart). */
export const registryResolver =
  (home: string): ChannelResolver =>
  (channelId) => {
    const picked = selectWorkspace(home, channelId);
    return "ws" in picked ? { workspace: picked.ws.name, channel: picked.channel.name } : null;
  };

/** Collaborators of the idle-episode writer (tests pass a fake `llm`, a fixed clock and a fake resolver). */
export interface IdleEpisodeDeps {
  db: Database;
  llm: CompactLlm;
  resolve: ChannelResolver;
  now?: () => number;
  /** Shutdown: stops the batch; an aborted model call writes nothing (the thread stays eligible). */
  signal?: AbortSignal;
  /**
   * Threads to leave alone for now (thread id -> `lastTurnStartedAt` when it failed or had no new facts): a thread that
   * keeps failing or has nothing to say must not hold the batch slots of newer ones. A new teammate turn lifts it. Kept by
   * the caller for the life of the process; a fresh map per call when absent.
   */
  skip?: Map<string, number>;
}

/**
 * Summary text of one idle thread. A compaction summary written inside or after the newest teammate turn already covers
 * it: reused, no model call (`reused`). Otherwise one model call over the earlier episode plus the db facts since; a model
 * error or an empty reply falls back to the facts text itself (extractive, so a failing model cannot make the
 * same threads eligible forever). Returns "aborted" when the call was aborted by
 * shutdown and "empty" when there is nothing new to say (nothing is saved, the TTL is not refreshed).
 */
async function summaryOf(
  d: IdleEpisodeDeps,
  t: IdleThread,
): Promise<{ text: string; reused: boolean } | "aborted" | "empty"> {
  if (t.summary !== "" && t.episodeAt >= t.lastTurnStartedAt)
    return { text: t.summary, reused: true };
  const facts = threadFacts(d.db, t.threadId, CHIEF_OF_STAFF, t.episodeAt);
  if (facts === "") return "empty";
  // The earlier episode (when any) leads the input, so the new text keeps what it said; the newest end is kept when clipped.
  const before = t.summary ? `Earlier episode:\n${t.summary}\n\n` : "";
  const input = redactText(`${before}${facts}`).slice(-EPISODE_INPUT_MAX_CHARS);
  try {
    const text = (await d.llm(EPISODE_SYSTEM, input, d.signal)).text.trim();
    if (text) return { text, reused: false };
    logEvent(log, "memory.episode_empty_reply", {}, "warn");
  } catch (err) {
    if (d.signal?.aborted) return "aborted";
    logEvent(log, "memory.episode_llm_failed", { err: errText(err, 200) }, "warn");
  }
  // Fallback: the facts alone (no header, so repeated failures never nest); the newest end is kept when clipped.
  return { text: redactText(facts).slice(-THREAD_SUMMARY_MAX_CHARS), reused: false };
}

/**
 * Write the episode of every idle thread (teammate idle for `EPISODE_IDLE_MS`, nothing running, new teammate work since the
 * last episode), at most `EPISODE_MAX_PER_TICK` per call, oldest first, one after the other. Saves through
 * `saveSummary` (redacted, abstract, topics; logs `memory.episode`) and indexes the row. A thread that fails is
 * logged and skipped. A thread with no mapped channel is skipped (no row, no model call). A thread that fails or has no new facts goes on the `skip` map until its next teammate turn. Returns how many episodes were written. Never throws.
 */
export async function writeIdleEpisodes(d: IdleEpisodeDeps): Promise<number> {
  const now = d.now?.() ?? Date.now();
  const skip = d.skip ?? new Map<string, number>();
  let written = 0;
  let failed = 0;
  let empty = 0;
  let stale = 0;
  let unmapped = 0;
  try {
    // Over-fetch by the skip list, so skipped threads never use up the batch.
    const threads = idleThreads(
      d.db,
      CHIEF_OF_STAFF,
      now - EPISODE_IDLE_MS,
      EPISODE_MAX_PER_TICK + skip.size,
    )
      .filter((t) => skip.get(t.threadId) !== t.lastTurnStartedAt)
      .slice(0, EPISODE_MAX_PER_TICK);
    for (const t of threads) {
      if (d.signal?.aborted) break;
      const t0 = Date.now();
      try {
        const where = d.resolve(t.channelId);
        // No channel to scope the episode to: no model call, no row (an episode of unknown channel is invisible anyway).
        if (!where?.channel) {
          skip.set(t.threadId, t.lastTurnStartedAt);
          unmapped++;
          continue;
        }
        const picked = await summaryOf(d, t);
        if (picked === "aborted") break;
        if (picked === "empty") {
          skip.set(t.threadId, t.lastTurnStartedAt);
          empty++;
          continue;
        }
        const saved = saveSummary(d.db, {
          threadId: t.threadId,
          workspace: where.workspace,
          channel: where.channel,
          summary: picked.text,
          source: "idle",
          ms: Date.now() - t0,
          now,
          unlessNewerThan: t.episodeAt,
        });
        if (!saved) {
          stale++;
          continue;
        }
        const row = getThreadSummary(d.db, t.threadId);
        if (row?.summary) safely("index episode", () => indexSummary(d.db, row));
        written++;
      } catch (err) {
        skip.set(t.threadId, t.lastTurnStartedAt);
        failed++;
        logEvent(log, "memory.episode_failed", { err: errText(err, 200) }, "warn");
      }
    }
    if (failed || empty || stale || unmapped)
      logEvent(log, "memory.episode_batch", {
        written,
        failed,
        empty,
        stale,
        unmapped,
        skipped: skip.size,
      });
  } catch (err) {
    logEvent(log, "memory.episode_failed", { err: errText(err, 200) }, "warn");
  }
  return written;
}
