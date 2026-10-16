import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import {
  type JournalDay,
  journalBullets,
  promotableJournal,
  renderJournal,
  safeRecentJournal,
} from "./journal-reader";
import { localDay } from "./memory-clock";
import {
  compactionOffenders,
  duplicateBullets,
  inputGroups,
  journalOnlyCount,
} from "./memory-compaction-check";
import { CallTimeoutError, type CompactLlm } from "./memory-compaction-llm";
import {
  buildCompacted,
  bulletDiff,
  bulletsOf,
  compactionPrompt,
  compactionSystem,
  parseCompacted,
} from "./memory-compaction-prompt";
import {
  isSymlink,
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import { bodyChars } from "./memory-owner-edit";
import type { MemoryTarget } from "./memory-targets";

export { type CompactLlm, sdkCompactLlm } from "./memory-compaction-llm";

const log = logger.child({ module: "memory-compaction" });

/** A file is compacted only when its body passes this share of its cap. */
export const COMPACT_THRESHOLD = 0.8;

/** Size of a file before / after. */
interface Sizes {
  chars: number;
  bullets: number;
}

/** Outcome for one file. `diff` lists removed `[-]` and added `[+]` bullets. */
export type CompactResult =
  | { status: "skipped"; label: string; chars: number; cap: number }
  | {
      status: "compacted" | "dry-run";
      label: string;
      cap: number;
      before: Sizes;
      after: Sizes;
      diff: string;
      proposed: string;
      /** Non-bullet prose lines not carried over (kept only in `.bak`). */
      droppedProse: number;
      /** Output bullets that exist only because of a journal note (workspace file; 0 otherwise). */
      fromJournal: number;
    }
  | { status: "aborted"; label: string; reason: string; diff?: string; offending?: string[] }
  | { status: "busy" | "changed" | "unchanged"; label: string }; // unchanged: proposal = old file, nothing written

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Abort result for a problem found before the model call. */
function abortEarly(t: MemoryTarget, reason: string): CompactResult {
  logEvent(log, "memory.compact_aborted", { file: t.label, reason }, "warn");
  return { status: "aborted", label: t.label, reason };
}

/**
 * Compact one memory file. The lock is NOT held during the model call; before the commit the file is
 * re-hashed under the lock (changed -> abort). Commit = `<file>.bak` (previous version, one generation) +
 * `<file>.tmp` + atomic rename. `dryRun` returns the proposal and writes nothing. Never throws on model or
 * validation problems: they come back as `aborted` with the diff.
 */
export async function compactFile(
  t: MemoryTarget,
  llm: CompactLlm,
  opts: { dryRun: boolean; date?: string; lockWaitMs?: number; journal?: readonly JournalDay[] },
): Promise<CompactResult> {
  const raw = existsSync(t.file) ? readFileSync(t.file, "utf8") : "";
  const chars = bodyChars(raw);
  // Journal notes count only for a workspace file; capped once, here.
  const journal = t.journalWorkspace ? promotableJournal(opts.journal ?? []) : [];
  // Promotable journal notes make a file run even under the threshold.
  if (chars <= t.cap * COMPACT_THRESHOLD && journal.length === 0)
    return { status: "skipped", label: t.label, chars, cap: t.cap };
  if (isSymlink(t.file)) return abortEarly(t, "memory file is a symlink: refusing to write");
  const hash = sha(raw);
  const inBullets = bulletsOf(raw);
  const abort = (
    reason: string,
    extra: { diff?: string; offending?: string[] } = {},
  ): CompactResult => {
    logEvent(log, "memory.compact_aborted", { file: t.label, reason }, "warn");
    return { status: "aborted", label: t.label, reason, ...extra };
  };
  let call: Awaited<ReturnType<CompactLlm>>;
  try {
    call = await llm(
      compactionSystem(t.cap, journal.length > 0),
      compactionPrompt(raw.trim(), renderJournal(journal)),
    );
  } catch (err) {
    // A deadline abort reads "model call timed out after N s", not the SDK's "aborted by user".
    return abort(
      err instanceof CallTimeoutError ? err.message : `model call failed: ${errText(err)}`,
    );
  }
  logEvent(log, "memory.compacted", { file: t.label, dryRun: opts.dryRun, ...call.usage });
  const parsed = parseCompacted(call.text);
  if (!parsed.ok) return abort(parsed.reason);
  const diff = bulletDiff(inBullets, parsed.bullets);
  // Kind sections in the old file must come back as kind sections (never flattened or dropped).
  if (inputGroups(raw).hasKind && !parsed.groups)
    return abort("output dropped the section headings of the old memory", { diff });
  // Text and date of every bullet must come from the old file (per section when sectioned).
  const pool = journalBullets(journal);
  const invented = [
    ...compactionOffenders(raw, parsed.bullets, parsed.groups, inBullets, pool),
    // A promoted bullet repeating a kept note (other date) aborts the run.
    ...(journal.length ? duplicateBullets(parsed.bullets) : []),
  ];
  if (invented.length)
    return abort("output has bullets not derivable from the old memory", {
      diff,
      offending: invented,
    });
  const today = opts.date ?? localDay();
  const { text: proposed, droppedProse } = buildCompacted(
    raw,
    t.template,
    parsed.bullets,
    today,
    parsed.groups,
  );
  if (bodyChars(proposed) > t.cap)
    return abort(`output is ${bodyChars(proposed)} chars, over the ${t.cap} cap`, { diff });
  // No-op: write nothing, keep the existing `.bak`.
  if (proposed.trim() === raw.trim()) return { status: "unchanged", label: t.label };
  const result: CompactResult = {
    status: opts.dryRun ? "dry-run" : "compacted",
    label: t.label,
    cap: t.cap,
    droppedProse,
    fromJournal: journalOnlyCount(raw, parsed.groups, pool),
    before: { chars, bullets: inBullets.length },
    after: { chars: bodyChars(proposed), bullets: parsed.bullets.length },
    diff,
    proposed,
  };
  if (opts.dryRun) return result;
  try {
    return withMemoryLock(
      t.file,
      () => {
        const now = readFileSync(t.file, "utf8");
        if (sha(now) !== hash) return { status: "changed", label: t.label } as CompactResult;
        writeAtomic(`${t.file}.bak`, now);
        writeAtomic(t.file, proposed);
        return result;
      },
      { waitMs: opts.lockWaitMs },
    );
  } catch (err) {
    if (err instanceof MemoryBusyError) return { status: "busy", label: t.label };
    if (err instanceof MemorySymlinkError)
      return abort("memory file is a symlink: refusing to write");
    throw err;
  }
}

/** Compact the files one after another. With `home`, a workspace file also gets its recent journal. */
export async function compactTargets(
  targets: MemoryTarget[],
  llm: CompactLlm,
  opts: { dryRun: boolean; home?: string },
): Promise<CompactResult[]> {
  const out: CompactResult[] = [];
  for (const t of targets) {
    try {
      const journal =
        opts.home && t.journalWorkspace ? safeRecentJournal(opts.home, t.journalWorkspace) : [];
      out.push(await compactFile(t, llm, { dryRun: opts.dryRun, journal }));
    } catch (err) {
      // One broken file (deleted meanwhile, .bak not writable...) must not stop the rest of the batch.
      out.push(abortEarly(t, `unexpected error: ${errText(err)}`));
    }
  }
  return out;
}
