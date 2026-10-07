import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import type { Repo } from "../repos/repo-registry";
import {
  BOOTSTRAP,
  DEFAULT_AGENTS,
  DEFAULT_IDENTITY,
  DEFAULT_SOUL,
  DEFAULT_USER,
  memoryTemplate,
  ROOT_MEMORY,
  workspaceIdentity,
} from "./persona-templates";

/** Max chars read from one persona file (4 files => at most 6000 chars of persona). */
export const PERSONA_MAX = 1500;
/** Marker appended to a persona file that was cut at PERSONA_MAX. */
export const TRUNCATED_MARK = "\n...(truncated)";

/** Write `text` to `file` only when the file does not exist yet. */
function ensureFile(file: string, text: string): void {
  if (!existsSync(file)) writeFileSync(file, text);
}

/**
 * Create the missing pieces of the home and of every workspace (never overwrites): root
 * AGENTS/IDENTITY/SOUL/USER/MEMORY/BOOTSTRAP, per-workspace IDENTITY + MEMORY + logs dir, and a CLAUDE.md symlink to the repo's own file.
 */
export function ensureHome(agentHome: string, repos: Repo[]): void {
  const paths = workspacePaths(agentHome);
  mkdirSync(paths.workspaces, { recursive: true });
  ensureFile(paths.identity, DEFAULT_IDENTITY);
  ensureFile(paths.soul, DEFAULT_SOUL);
  ensureFile(paths.agents, DEFAULT_AGENTS);
  ensureFile(paths.user, DEFAULT_USER);
  ensureFile(paths.memory, ROOT_MEMORY);
  ensureFile(paths.bootstrap, BOOTSTRAP);
  for (const r of repos) {
    const ws = paths.workspace(r.name);
    mkdirSync(ws.logs, { recursive: true });
    ensureFile(ws.identity, workspaceIdentity(r));
    ensureFile(ws.memory, memoryTemplate(r.name));
    const claude = join(r.path, "CLAUDE.md");
    // Forward link only: the repo's own (tracked) file stays untouched; the workspace just points at it.
    try {
      if (existsSync(claude) && !existsSync(ws.claude)) symlinkSync(claude, ws.claude);
    } catch {
      /* link already exists or is not allowed: not fatal */
    }
  }
}

/**
 * Read a persona file for the prompt: HTML comments stripped, "" when missing, comment-only or
 * heading-only (a template), else capped at PERSONA_MAX with a truncated marker.
 */
function readPersona(file: string): string {
  try {
    if (!existsSync(file)) return "";
    const body = readFileSync(file, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (!body || /^#[^\n]*$/.test(body)) return "";
    return body.length > PERSONA_MAX ? `${body.slice(0, PERSONA_MAX)}${TRUNCATED_MARK}` : body;
  } catch {
    return "";
  }
}

/**
 * AGENTS, IDENTITY, SOUL, USER for a run (this order: operating notes first, then who, tone, owner).
 * Per file the workspace's own non-empty file replaces the root one. `workspace` is undefined for runs
 * that span several repos (root files only). `truncated` is true when any file hit PERSONA_MAX.
 */
export function buildPersonaContext(
  agentHome: string,
  workspace?: string,
): { text: string; truncated: boolean } {
  const paths = workspacePaths(agentHome);
  const ws = workspace ? paths.workspace(workspace) : undefined;
  const parts = (["agents", "identity", "soul", "user"] as const)
    .map((k) => readPersona(ws?.[k] ?? "") || readPersona(paths[k]))
    .filter(Boolean);
  return {
    text: parts.join("\n\n"),
    truncated: parts.some((p) => p.endsWith(TRUNCATED_MARK)),
  };
}
