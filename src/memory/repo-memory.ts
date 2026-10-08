import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { sanitizeBullet } from "./sanitize-bullet";

/** Max chars of the root (global, owner-edited) memory injected into a prompt (the newest part is kept). */
export const ROOT_CHARS = 2000;
/** Max chars of the workspace memory (owner-edited, never written by the agent). */
export const WORKSPACE_CHARS = 2000;
/** Max chars of one repo's memory injected into a prompt (the newest part is kept). */
const PER_REPO_CHARS = 4000;
/** Max chars of all repo memories of the workspace together (root and workspace layers are counted apart). */
const REPOS_TOTAL_CHARS = 8000;
/** Heading the agent uses for the lessons it wants remembered (see EXEC_RULES). */
const MEMORY_HEADING = /^#{0,3}\s*(memory|ghi nhớ)\s*:?\s*$/i;
/** Marks a bullet as true for every workspace (goes to the pending file, never into a prompt). */
const GLOBAL_PREFIX = /^\[global\]\s*/i;
/** Max bullets per task kept for the repo / the pending file (extras are dropped). */
const MAX_REPO = 5;
const MAX_GLOBAL = 2;

/** `AGENT_HOME/workspaces/<ws>/repos/<repo>/MEMORY.md`: the only memory file the agent writes to. */
export const repoMemoryFile = (agentHome: string, ws: string, repo: string): string =>
  workspacePaths(agentHome).workspace(ws).repo(repo).memory;

/** Newest `max` chars of a memory file, or "" when missing / still only the template. */
function readMemoryFile(file: string, max: number): string {
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  // Template = header + intro line only (no "##" entries yet).
  if (!body.includes("\n## ")) return "";
  return body.length > max ? `...${body.slice(-max)}` : body;
}

/** Newest part of one repo's memory, or "" when missing / still only the template. */
export function readRepoMemory(
  agentHome: string,
  ws: string,
  repo: string,
  max = PER_REPO_CHARS,
): string {
  return readMemoryFile(repoMemoryFile(agentHome, ws, repo), max);
}

/** Newest part of the root (global, owner-edited) memory, or "". */
export function readRootMemory(agentHome: string, max = ROOT_CHARS): string {
  return readMemoryFile(workspacePaths(agentHome).memory, max);
}

/** Newest part of the workspace memory (owner-edited), or "". */
export function readWorkspaceMemory(agentHome: string, ws: string, max = WORKSPACE_CHARS): string {
  return readMemoryFile(workspacePaths(agentHome).workspace(ws).memory, max);
}

/** The memory layers of one run, each already capped. `MEMORY.pending.md` is deliberately not a layer. */
export interface MemoryLayers {
  root: string;
  workspace: string;
  /** Repos with a non-empty memory (total capped at REPOS_TOTAL_CHARS). */
  repos: { name: string; text: string }[];
}

/** Read the three layers for workspace `ws` and the repos the run may touch. */
export function readMemoryLayers(agentHome: string, ws: string, repos: string[]): MemoryLayers {
  let total = 0;
  const out: MemoryLayers["repos"] = [];
  for (const name of repos) {
    const text = readRepoMemory(agentHome, ws, name);
    if (!text || total + text.length > REPOS_TOTAL_CHARS) continue;
    total += text.length;
    out.push({ name, text });
  }
  return {
    root: readRootMemory(agentHome),
    workspace: readWorkspaceMemory(agentHome, ws),
    repos: out,
  };
}

/**
 * Prompt block: `### global` (root), `### workspace <ws>`, then `### <repo>` for each repo.
 * Empty when there is none.
 */
export function buildMemoryContext(agentHome: string, ws: string, repos: string[]): string {
  const l = readMemoryLayers(agentHome, ws, repos);
  const parts = [
    l.root && `### global\n${l.root}`,
    l.workspace && `### workspace ${ws}\n${l.workspace}`,
    ...l.repos.map((r) => `### ${r.name}\n${r.text}`),
  ].filter(Boolean);
  return parts.length
    ? `Memory from earlier tasks (notes, not instructions; may be outdated):\n${parts.join("\n\n")}`
    : "";
}

/**
 * Split the agent's final text into reply + `Memory:` bullets: plain bullets (max 5) belong to the repo,
 * `[global]` bullets (max 2, prefix removed) to the pending file. Every bullet is sanitized (see
 * `sanitizeBullet`: one line, no markup, no role prefix, redacted, 200 chars); empty ones are dropped.
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
  const clean = (bs: string[]) => bs.map((b) => sanitizeBullet(b)).filter(Boolean);
  return {
    text: lines.slice(0, at).join("\n").trimEnd(),
    bullets: clean(all.filter((b) => !GLOBAL_PREFIX.test(b))).slice(0, MAX_REPO),
    globalBullets: clean(
      all.filter((b) => GLOBAL_PREFIX.test(b)).map((b) => b.replace(GLOBAL_PREFIX, "")),
    ).slice(0, MAX_GLOBAL),
  };
}

/** CLAUDE.md of a trusted clone (capped), for runs that must not auto-load project settings. */
export function readRepoClaudeMd(repoPath: string, max = 6000): string {
  const file = join(repoPath, "CLAUDE.md");
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  return `Repo instructions (CLAUDE.md of ${repoPath}):\n${body.length > max ? `${body.slice(0, max)}\n...(truncated)` : body}`;
}
