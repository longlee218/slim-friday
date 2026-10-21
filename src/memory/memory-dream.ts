import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { DREAM_DEBOUNCE_MS, DREAM_MAX_ITEMS, DREAM_MIN_ITEMS } from "../config/memory-caps";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { DREAM_SYSTEM } from "../roles/prompts/memory-prompts";
import { markEpisodesPromoted } from "../storage/episode-store";
import { markPromoted } from "../storage/memory-promotion-store";
import { applyDream, DreamStageError } from "./dream-apply";
import { collectDreamItems } from "./dream-inputs";
import { buildPrompt, bulletsOf, parseReply } from "./dream-reply";
import { channelDirs, listWorkspaces } from "./index/memory-files";
import { reindexFile } from "./index/memory-index";
import { safely } from "./index/safely";
import type { CompactLlm } from "./memory-compaction-llm";
import { channelTarget } from "./memory-targets";

const log = logger.child({ module: "memory-dream" });

/** Process-lifetime state of the dream scheduler (kept by the caller): last attempt per channel and running channels. */
export interface DreamState {
  last: Map<string, number>;
  running: Set<string>;
}

/** Collaborators of a dream (tests pass a fake `llm` and a fixed clock). */
export interface DreamDeps {
  db: Database;
  home: string;
  llm: CompactLlm;
  state: DreamState;
  now?: () => number;
  signal?: AbortSignal;
}

/** Outcome of one channel: `dreamed` (file or marks changed), or the reason nothing happened. */
export type DreamResult =
  | "dreamed"
  | "few_items"
  | "debounce"
  | "running"
  | "llm_failed"
  | "backup_failed"
  | "io_failed"
  | "db_failed"
  | "bad_reply"
  | "shrink_guard"
  | "file_changed"
  | "not_utf8"
  | "busy"
  | "aborted";

/**
 * One dream of one channel: >= `DREAM_MIN_ITEMS` unconsumed items (episodes + journal blocks), debounced, the oldest
 * `DREAM_MAX_ITEMS` go to one model call (outside any lock). The result is applied under the memory file lock to the
 * file as it is NOW: bullets added since the model input are kept, the shrink guard can refuse, the old file is backed
 * up, then written atomically. Only after a successful write (or a no-change result) are the items marked consumed;
 * a failure leaves the file and the marks as they were. Logs counts only, never content. Never throws.
 */
export async function dreamChannel(
  d: DreamDeps,
  workspace: string,
  channel: string,
): Promise<DreamResult> {
  const nowMs = d.now?.() ?? Date.now();
  const key = `${workspace}/${channel}`;
  const skip = (reason: DreamResult): DreamResult => {
    logEvent(log, "memory.dream_skipped", { workspace, channel, reason });
    return reason;
  };
  if (d.state.running.has(key)) return skip("running");
  const items = collectDreamItems(d.db, d.home, workspace, channel, new Date(nowMs));
  if (items.length < DREAM_MIN_ITEMS) return "few_items"; // the common case: not logged
  if (nowMs - (d.state.last.get(key) ?? 0) < DREAM_DEBOUNCE_MS) return skip("debounce");
  d.state.running.add(key);
  d.state.last.set(key, nowMs); // a failed attempt counts too (no back-off, owner accepted the retry cost)
  const t0 = Date.now();
  try {
    const used = items.slice(0, DREAM_MAX_ITEMS);
    const target = channelTarget(d.home, workspace, channel);
    const before = existsSync(target.file) ? readFileSync(target.file, "utf8") : target.template;
    const input = buildPrompt(before, used);
    if (input.sent.length < input.total)
      logEvent(
        log,
        "memory.dream_notes_capped",
        { workspace, channel, reason: "over_budget", total: input.total, sent: input.sent.length },
        "warn",
      );
    let raw: string;
    try {
      raw = (await d.llm(DREAM_SYSTEM, input.prompt, d.signal)).text;
    } catch (err) {
      if (d.signal?.aborted) return skip("aborted");
      logEvent(
        log,
        "memory.dream_llm_failed",
        { workspace, channel, err: errText(err, 200) },
        "warn",
      );
      return skip("llm_failed");
    }
    const reply = parseReply(raw);
    if (!reply) return skip("bad_reply");
    const newest = used.reduce((m, it) => (it.date > m ? it.date : m), "");
    const proposed = bulletsOf(reply, newest);
    const res = applyDream(
      d,
      { workspace, channel },
      target,
      proposed,
      input.sent,
      new Date(nowMs),
    );
    if (typeof res === "string") return skip(res);
    // Consume the items (after the write; a crash in between only makes the next dream use them again).
    try {
      d.db.transaction(() => {
        markEpisodesPromoted(
          d.db,
          used.flatMap((it) => (it.episode ? [it.episode] : [])),
        );
        markPromoted(
          d.db,
          workspace,
          channel,
          used.flatMap((it) => it.hashes ?? []),
          nowMs,
        );
      })();
    } catch (err) {
      logEvent(
        log,
        "memory.dream_failed",
        { workspace, channel, reason: "db_failed", err: errText(err, 200) },
        "warn",
      );
      return "db_failed";
    }
    if (res.changed) safely("reindex dream", () => reindexFile(d.db, d.home, target.file));
    logEvent(log, "memory.dream", {
      workspace,
      channel,
      episodes: used.filter((i) => i.episode).length,
      journalItems: used.filter((i) => i.hashes).length,
      ...res.stats,
      ms: Date.now() - t0,
    });
    return "dreamed";
  } catch (err) {
    // The model call has its own handler above: what reaches here is a step of the locked part or the file read.
    const reason = err instanceof DreamStageError ? err.reason : "io_failed";
    const cause = err instanceof DreamStageError ? err.cause : err;
    logEvent(
      log,
      "memory.dream_failed",
      { workspace, channel, reason, err: errText(cause, 200) },
      "warn",
    );
    return reason;
  } finally {
    d.state.running.delete(key);
  }
}

/**
 * Dream every channel of every workspace on disk, one after the other (the memory tick calls this). One channel's
 * failure never stops the others. Returns how many channels dreamed.
 */
export async function dreamAll(d: DreamDeps): Promise<number> {
  let dreamed = 0;
  for (const ws of listWorkspaces(d.home)) {
    for (const ch of channelDirs(workspacePaths(d.home).workspace(ws).channels)) {
      if (d.signal?.aborted) return dreamed;
      if ((await dreamChannel(d, ws, ch)) === "dreamed") dreamed++;
    }
  }
  return dreamed;
}
