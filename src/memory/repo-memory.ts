import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { redactText } from "../observability/redact";

/** Max chars of one repo's memory injected into a prompt (the newest part is kept). */
const PER_REPO_CHARS = 4000;
/** Max chars of all injected memory together. */
const TOTAL_CHARS = 8000;
/** MEMORY.md is kept at or under this many lines; trimmed (oldest sections first) once it passes +5%. */
const MAX_LINES = 300;
const TRIM_AT_LINES = Math.ceil(MAX_LINES * 1.05);
/** Heading the agent uses for the lessons it wants remembered (see EXEC_RULES). */
const MEMORY_HEADING = /^#{0,3}\s*(memory|ghi nhớ)\s*:?\s*$/i;

/** `AGENT_HOME/workspaces/<repo>/MEMORY.md`: one owner-editable file per workspace. */
export const memoryFile = (agentHome: string, repo: string): string =>
  workspacePaths(agentHome).workspace(repo).memory;

/** Newest part of a repo's memory, or "" when missing / still only the template. */
export function readRepoMemory(agentHome: string, repo: string, max = PER_REPO_CHARS): string {
  const file = memoryFile(agentHome, repo);
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  // Template = header + intro line only (no "##" entries yet).
  if (!body.includes("\n## ")) return "";
  return body.length > max ? `...${body.slice(-max)}` : body;
}

/** Prompt block with the memory of the given repos (empty when there is none). */
export function buildMemoryContext(agentHome: string, repos: string[]): string {
  let total = 0;
  const parts: string[] = [];
  for (const name of repos) {
    const m = readRepoMemory(agentHome, name);
    if (!m || total + m.length > TOTAL_CHARS) continue;
    total += m.length;
    parts.push(`### ${name}\n${m}`);
  }
  return parts.length
    ? `Memory from earlier tasks (owner-curated, may be outdated):\n${parts.join("\n\n")}`
    : "";
}

/** Split the agent's final text into reply + `Memory:` bullets (max 5, 200 chars each). */
export function extractMemory(text: string): { text: string; bullets: string[] } {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => MEMORY_HEADING.test(l.trim()));
  if (at < 0) return { text, bullets: [] };
  const bullets = lines
    .slice(at + 1)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").slice(0, 200))
    .slice(0, 5);
  return { text: lines.slice(0, at).join("\n").trimEnd(), bullets };
}

/** Drop the oldest `## ` sections until the text has at most MAX_LINES lines (header always kept). */
function trimToLines(text: string): string {
  const [head = "", ...secs] = text.split(/\n(?=## )/);
  const count = () => `${head}\n${secs.join("\n")}`.split("\n").length;
  while (secs.length > 1 && count() > MAX_LINES) secs.shift();
  return `${head}\n${secs.join("\n")}`;
}

/** Append a dated section to the repo's memory file (redacted; oldest sections dropped when too big). */
export function appendRepoMemory(
  agentHome: string,
  repo: string,
  title: string,
  bullets: string[],
): void {
  if (bullets.length === 0) return;
  const file = memoryFile(agentHome, repo);
  mkdirSync(dirname(file), { recursive: true });
  const old = existsSync(file) ? readFileSync(file, "utf8") : `# ${repo} memory\n`;
  const date = new Date().toISOString().slice(0, 10);
  const section = `\n## ${date} ${redactText(title).slice(0, 80)}\n${bullets.map((b) => `- ${redactText(b)}`).join("\n")}\n`;
  let next = `${old.trimEnd()}\n${section}`;
  if (next.split("\n").length > TRIM_AT_LINES) next = trimToLines(next);
  writeFileSync(file, next);
  logEvent(logger, "memory.appended", { repo, bullets: bullets.length });
}

/** CLAUDE.md of a trusted clone (capped), for runs that must not auto-load project settings. */
export function readRepoClaudeMd(repoPath: string, max = 6000): string {
  const file = join(repoPath, "CLAUDE.md");
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  return `Repo instructions (CLAUDE.md of ${repoPath}):\n${body.length > max ? `${body.slice(0, max)}\n...(truncated)` : body}`;
}
