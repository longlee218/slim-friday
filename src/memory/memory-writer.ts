import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { localDay } from "./memory-clock";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
  writeAtomic,
} from "./memory-file-lock";
import { MEMORY_SECTION_HEADINGS } from "./memory-sections";
import { repoMemoryFile } from "./repo-memory";
import { sanitizeBullet } from "./sanitize-bullet";

/** Logger of this module. */
const log = logger.child({ module: "memory-writer" });

/** A memory file is kept at or under this many lines; trimmed (oldest sections first) once it passes +5%. */
const MAX_LINES = 300;
const TRIM_AT_LINES = Math.ceil(MAX_LINES * 1.05);

/** Number of `## ` sections in a memory text. */
const sectionCount = (text: string): number => text.split(/\n(?=## )/).length - 1;

/** A kind section (`## Decisions`...) holds long-lived notes: trimming never drops it (only dated legacy sections go). */
const isKindSection = (sec: string): boolean =>
  MEMORY_SECTION_HEADINGS.includes((sec.split("\n")[0] ?? "").trim().replace(/^## /, ""));

/** Drop the oldest dated `## ` sections until the text has at most MAX_LINES lines (header and kind sections kept). */
function trimToLines(text: string): string {
  const [head = "", ...secs] = text.split(/\n(?=## )/);
  const count = () => `${head}\n${secs.join("\n")}`.split("\n").length;
  while (secs.length > 1 && count() > MAX_LINES) {
    const at = secs.findIndex((sec) => !isKindSection(sec));
    // Only kind sections left: stop (compaction shrinks those, trimming must not eat them).
    if (at < 0) break;
    secs.splice(at, 1);
  }
  return `${head}\n${secs.join("\n")}`;
}

/**
 * Append a dated section to one memory file: bullets and title sanitized, bullets already in the file skipped
 * (nothing new = file untouched, no log), oldest sections dropped when too big.
 */
function appendMemory(
  file: string,
  header: string,
  title: string,
  bullets: string[],
  fields: { workspace: string; repo: string; layer: "repo" | "pending" },
): void {
  if (bullets.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  try {
    // Read-modify-write under the per-file lock (owner commands and compaction write the same files).
    withMemoryLock(file, () => appendLocked(file, header, title, bullets, fields));
  } catch (err) {
    if (!(err instanceof MemoryBusyError || err instanceof MemorySymlinkError)) throw err;
    // Never silent: the lessons of this task are lost, say so.
    logEvent(
      log,
      "memory.write_failed",
      {
        ...fields,
        bullets: bullets.length,
        reason: err instanceof MemorySymlinkError ? "symlink" : "busy",
      },
      "warn",
    );
  }
}

/** The read-modify-write of `appendMemory`; the caller holds the file lock. */
function appendLocked(
  file: string,
  header: string,
  title: string,
  bullets: string[],
  fields: { workspace: string; repo: string; layer: "repo" | "pending" },
): void {
  const old = existsSync(file) ? readFileSync(file, "utf8") : `${header}\n`;
  const known = new Set(old.split("\n"));
  const fresh = bullets
    .map((b) => sanitizeBullet(b))
    .filter(Boolean)
    .map((b) => `- ${b}`)
    .filter((l) => !known.has(l));
  if (fresh.length === 0) return;
  const date = localDay();
  const section = `\n## ${date} ${sanitizeBullet(title, 80)}\n${fresh.join("\n")}\n`;
  let next = `${old.trimEnd()}\n${section}`;
  if (next.split("\n").length > TRIM_AT_LINES) {
    const before = sectionCount(next);
    next = trimToLines(next);
    // Oldest sections vanish here: the owner must be able to see it in the log.
    logEvent(
      log,
      "memory.trimmed",
      { ...fields, droppedSections: before - sectionCount(next) },
      "warn",
    );
  }
  writeAtomic(file, next);
  logEvent(log, "memory.appended", { ...fields, bullets: fresh.length });
}

/** Header of the quarantine file for `[global]` bullets. */
export const PENDING_HEADER =
  "# pending global memory (agent notes, never injected; the owner promotes by hand to MEMORY.md)";

/**
 * Write the lessons of one task: plain bullets to the repo's MEMORY.md, `[global]` bullets to the root
 * `MEMORY.pending.md` (stamped date + workspace/repo). The workspace and root MEMORY.md are never written.
 */
export function appendTaskMemory(
  agentHome: string,
  ws: string,
  repo: string,
  title: string,
  bullets: { bullets: string[]; globalBullets: string[] },
): void {
  appendMemory(repoMemoryFile(agentHome, ws, repo), `# ${repo} memory`, title, bullets.bullets, {
    workspace: ws,
    repo,
    layer: "repo",
  });
  appendMemory(
    workspacePaths(agentHome).memoryPending,
    PENDING_HEADER,
    `${ws}/${repo}: ${title}`,
    bullets.globalBullets,
    { workspace: ws, repo, layer: "pending" },
  );
}
