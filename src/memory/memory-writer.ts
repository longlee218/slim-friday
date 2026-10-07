import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { redactText } from "../observability/redact";
import { memoryFile } from "./repo-memory";

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
 * Append a dated section to one memory file: bullets redacted, bullets already in the file skipped
 * (nothing new = file untouched, no log), oldest sections dropped when too big.
 */
function appendMemory(
  file: string,
  header: string,
  title: string,
  bullets: string[],
  fields: { repo: string; layer: "workspace" | "global" },
): void {
  if (bullets.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const old = existsSync(file) ? readFileSync(file, "utf8") : `${header}\n`;
  const known = new Set(old.split("\n"));
  const fresh = bullets.map((b) => `- ${redactText(b)}`).filter((l) => !known.has(l));
  if (fresh.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const section = `\n## ${date} ${redactText(title).slice(0, 80)}\n${fresh.join("\n")}\n`;
  let next = `${old.trimEnd()}\n${section}`;
  if (next.split("\n").length > TRIM_AT_LINES) next = trimToLines(next);
  writeFileSync(file, next);
  logEvent(log, "memory.appended", { ...fields, bullets: fresh.length });
}

/**
 * Write the lessons of one task: plain bullets to the workspace MEMORY.md, `[global]` bullets to the
 * root MEMORY.md (heading stamped with date + source workspace).
 */
export function appendTaskMemory(
  agentHome: string,
  repo: string,
  title: string,
  bullets: { bullets: string[]; globalBullets: string[] },
): void {
  appendMemory(memoryFile(agentHome, repo), `# ${repo} memory`, title, bullets.bullets, {
    repo,
    layer: "workspace",
  });
  appendMemory(
    workspacePaths(agentHome).memory,
    "# global memory",
    `${repo}: ${title}`,
    bullets.globalBullets,
    { repo, layer: "global" },
  );
}
