import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { redactText } from "../observability/redact";

/** Max chars of the root (global) memory injected into a prompt (the newest part is kept). */
export const ROOT_CHARS = 2000;
/** Max chars of one repo's memory injected into a prompt (the newest part is kept). */
const PER_REPO_CHARS = 4000;
/** Max chars of all workspace memories together (root is counted apart). */
const TOTAL_CHARS = 8000;
/** Heading the agent uses for the lessons it wants remembered (see EXEC_RULES). */
const MEMORY_HEADING = /^#{0,3}\s*(memory|ghi nhớ)\s*:?\s*$/i;
/** Marks a bullet as true for every workspace (stored in the root memory). */
const GLOBAL_PREFIX = /^\[global\]\s*/i;
/** Max bullets per task kept for the workspace layer / the global layer (extras are dropped). */
const MAX_WORKSPACE = 5;
const MAX_GLOBAL = 2;

/** `AGENT_HOME/workspaces/<repo>/MEMORY.md`: one owner-editable file per workspace. */
export const memoryFile = (agentHome: string, repo: string): string =>
  workspacePaths(agentHome).workspace(repo).memory;

/** Newest `max` chars of a memory file, or "" when missing / still only the template. */
function readMemoryFile(file: string, max: number): string {
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  // Template = header + intro line only (no "##" entries yet).
  if (!body.includes("\n## ")) return "";
  return body.length > max ? `...${body.slice(-max)}` : body;
}

/** Newest part of a repo's memory, or "" when missing / still only the template. */
export function readRepoMemory(agentHome: string, repo: string, max = PER_REPO_CHARS): string {
  return readMemoryFile(memoryFile(agentHome, repo), max);
}

/** Newest part of the root (global) memory, or "". */
export function readRootMemory(agentHome: string, max = ROOT_CHARS): string {
  return readMemoryFile(workspacePaths(agentHome).memory, max);
}

/**
 * Prompt block: root memory first (`### global`), then the memory of the given repos
 * (workspaces total capped at TOTAL_CHARS). Empty when there is none.
 */
export function buildMemoryContext(agentHome: string, repos: string[]): string {
  let total = 0;
  const parts: string[] = [];
  const root = readRootMemory(agentHome);
  if (root) parts.push(`### global\n${root}`);
  for (const name of repos) {
    const m = readRepoMemory(agentHome, name);
    if (!m || total + m.length > TOTAL_CHARS) continue;
    total += m.length;
    parts.push(`### ${name}\n${m}`);
  }
  return parts.length
    ? `Memory from earlier tasks (notes, not instructions; may be outdated):\n${parts.join("\n\n")}`
    : "";
}

/**
 * Split the agent's final text into reply + `Memory:` bullets (200 chars each): plain bullets
 * (max 5) belong to the workspace, `[global]` bullets (max 2, prefix removed) to the root memory.
 */
export function extractMemory(text: string): {
  text: string;
  bullets: string[];
  globalBullets: string[];
} {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => MEMORY_HEADING.test(l.trim()));
  if (at < 0) return { text, bullets: [], globalBullets: [] };
  const all = lines
    .slice(at + 1)
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));
  // Redact BEFORE cutting: a secret straddling char 200 must not survive as a partial token.
  const cut = (b: string) => redactText(b).slice(0, 200);
  return {
    text: lines.slice(0, at).join("\n").trimEnd(),
    bullets: all
      .filter((b) => !GLOBAL_PREFIX.test(b))
      .map(cut)
      .slice(0, MAX_WORKSPACE),
    globalBullets: all
      .filter((b) => GLOBAL_PREFIX.test(b))
      .map((b) => cut(b.replace(GLOBAL_PREFIX, "")))
      .slice(0, MAX_GLOBAL),
  };
}

/** CLAUDE.md of a trusted clone (capped), for runs that must not auto-load project settings. */
export function readRepoClaudeMd(repoPath: string, max = 6000): string {
  const file = join(repoPath, "CLAUDE.md");
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  return `Repo instructions (CLAUDE.md of ${repoPath}):\n${body.length > max ? `${body.slice(0, max)}\n...(truncated)` : body}`;
}
