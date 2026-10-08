import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { repoMemoryFile } from "./repo-memory";
import { sanitizeBullet } from "./sanitize-bullet";

/** Logger of this module. */
const log = logger.child({ module: "memory-writer" });

/** A memory file is kept at or under this many lines; trimmed (oldest sections first) once it passes +5%. */
const MAX_LINES = 300;
const TRIM_AT_LINES = Math.ceil(MAX_LINES * 1.05);

/** Drop the oldest `## ` sections until the text has at most MAX_LINES lines (header always kept). */
function trimToLines(text: string): string {
  const [head = "", ...secs] = text.split(/\n(?=## )/);
  const count = () => `${head}\n${secs.join("\n")}`.split("\n").length;
  while (secs.length > 1 && count() > MAX_LINES) secs.shift();
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
  const old = existsSync(file) ? readFileSync(file, "utf8") : `${header}\n`;
  const known = new Set(old.split("\n"));
  const fresh = bullets
    .map((b) => sanitizeBullet(b))
    .filter(Boolean)
    .map((b) => `- ${b}`)
    .filter((l) => !known.has(l));
  if (fresh.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const section = `\n## ${date} ${sanitizeBullet(title, 80)}\n${fresh.join("\n")}\n`;
  let next = `${old.trimEnd()}\n${section}`;
  if (next.split("\n").length > TRIM_AT_LINES) next = trimToLines(next);
  writeFileSync(file, next);
  logEvent(log, "memory.appended", { ...fields, bullets: fresh.length });
}

/** Header of the quarantine file for `[global]` bullets. */
const PENDING_HEADER =
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
