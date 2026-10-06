import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import type { Repo } from "../repos/repo-registry";

/** Max chars read from one persona file. */
const PERSONA_MAX = 3000;

/** Default identity card (who the agent is). Owner-editable; created once when missing. */
const DEFAULT_IDENTITY = `# Identity
- Name: Friday
- Role: personal coding agent of the owner, reached through Discord threads.
- Does: answers code questions with file:line, plans and implements approved tasks in isolated git worktrees, opens PRs only after the owner approves.
- Works only on the registered repos (one workspace per repo).
`;

/** Default soul (tone of the replies). Owner-editable; created once when missing. */
const DEFAULT_SOUL = `# Soul
- Always reply in Vietnamese, even if the question is in English. Keep code, identifiers, file paths and file:line references unchanged.
- Concise, direct, calm. Lead with the answer; bullets over paragraphs.
- No flattery and no filler. State uncertainty briefly; never invent facts.
`;

/** Per-workspace identity: which repo this workspace is. */
const workspaceIdentity = (r: Repo) => `# Identity
- Name: Friday, working on the repo \`${r.name}\`${r.description ? ` (${r.description})` : ""}.
- Repo path: ${r.path}
- Conventions: CLAUDE.md, CLAUDE.local.md and MEMORY.md in this workspace describe how to work and code here.
`;

/** Per-workspace memory template (a header only: it counts as empty until the first entry). */
const memoryTemplate = (name: string) =>
  `# ${name} memory\n\nLessons the Friday agent keeps about this repo. Newest last. Kept under 300 lines (oldest sections are dropped).\n`;

/** Write `text` to `file` only when the file does not exist yet. */
function ensureFile(file: string, text: string): void {
  if (!existsSync(file)) writeFileSync(file, text);
}

/**
 * Create the missing pieces of the home and of every workspace (never overwrites): default
 * IDENTITY/SOUL, per-workspace IDENTITY + MEMORY + logs dir, and a CLAUDE.md symlink to the repo's own file.
 */
export function ensureHome(agentHome: string, repos: Repo[]): void {
  const paths = workspacePaths(agentHome);
  mkdirSync(paths.workspaces, { recursive: true });
  ensureFile(paths.identity, DEFAULT_IDENTITY);
  ensureFile(paths.soul, DEFAULT_SOUL);
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

/** Read a persona file (capped), "" when missing. */
function readPersona(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim().slice(0, PERSONA_MAX) : "";
  } catch {
    return "";
  }
}

/**
 * IDENTITY + SOUL for a run: the workspace's own file when present, else the shared default.
 * `repo` is undefined for runs that span several repos (shared defaults only).
 */
export function buildPersonaContext(agentHome: string, repo?: string): string {
  const paths = workspacePaths(agentHome);
  const ws = repo ? paths.workspace(repo) : undefined;
  const identity = readPersona(ws?.identity ?? "") || readPersona(paths.identity);
  const soul = readPersona(ws?.soul ?? "") || readPersona(paths.soul);
  return [identity, soul].filter(Boolean).join("\n\n");
}
