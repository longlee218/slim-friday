import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import type { CompactLlm } from "./memory-compaction-llm";
import {
  buildCompacted,
  bulletDiff,
  bulletsOf,
  compactionPrompt,
  compactionSystem,
  parseCompacted,
} from "./memory-compaction-prompt";
import { nonDerivable } from "./memory-derivability";
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
export interface Sizes {
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
    }
  | { status: "aborted"; label: string; reason: string; diff?: string; offending?: string[] }
  | { status: "busy" | "changed"; label: string };

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
  opts: { dryRun: boolean; date?: string; lockWaitMs?: number },
): Promise<CompactResult> {
  const raw = existsSync(t.file) ? readFileSync(t.file, "utf8") : "";
  const chars = bodyChars(raw);
  if (chars <= t.cap * COMPACT_THRESHOLD)
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
    call = await llm(compactionSystem(t.cap), compactionPrompt(raw.trim()));
  } catch (err) {
    return abort(`model call failed: ${errText(err)}`);
  }
  logEvent(log, "memory.compacted", { file: t.label, dryRun: opts.dryRun, ...call.usage });
  const parsed = parseCompacted(call.text);
  if (!parsed.ok) return abort(parsed.reason);
  const diff = bulletDiff(inBullets, parsed.bullets);
  const invented = nonDerivable(inBullets, parsed.bullets);
  if (invented.length)
    return abort("output has bullets not derivable from the old memory", {
      diff,
      offending: invented,
    });
  const today = opts.date ?? new Date().toISOString().slice(0, 10);
  const { text: proposed, droppedProse } = buildCompacted(raw, t.template, parsed.bullets, today);
  if (bodyChars(proposed) > t.cap)
    return abort(`output is ${bodyChars(proposed)} chars, over the ${t.cap} cap`, { diff });
  const result: CompactResult = {
    status: opts.dryRun ? "dry-run" : "compacted",
    label: t.label,
    cap: t.cap,
    droppedProse,
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

/** Compact the files one after another (one model call per file over the threshold). */
export async function compactTargets(
  targets: MemoryTarget[],
  llm: CompactLlm,
  opts: { dryRun: boolean },
): Promise<CompactResult[]> {
  const out: CompactResult[] = [];
  for (const t of targets) {
    try {
      out.push(await compactFile(t, llm, opts));
    } catch (err) {
      // One broken file (deleted meanwhile, .bak not writable...) must not stop the rest of the batch.
      out.push(abortEarly(t, `unexpected error: ${errText(err)}`));
    }
  }
  return out;
}
