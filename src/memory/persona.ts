import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import type { Workspace } from "../workspaces/workspace-registry";
import {
  BOOTSTRAP,
  channelMemoryTemplate,
  DEFAULT_AGENTS,
  DEFAULT_IDENTITY,
  DEFAULT_SOUL,
  DEFAULT_USER,
  memoryTemplate,
  ROOT_MEMORY,
  workspaceMemoryTemplate,
} from "./persona-templates";

/** Max chars read from one persona file (4 files => at most 24000 chars of persona). */
export const PERSONA_MAX = 6000;
/** Marker appended to a persona file that was cut at PERSONA_MAX. */
export const TRUNCATED_MARK = "\n...(truncated)";

/**
 * Write `text` to `file` only when the file does not exist yet. The parent folder is created first: a location
 * added to workspace.yaml by hand (or one that was refused before and is accepted now) has no folder yet.
 */
function ensureFile(file: string, text: string): void {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** Create `channels/<name>/` and its MEMORY.md for a channel of space `ws` (never overwrites). */
export function ensureChannelDir(agentHome: string, ws: string, name: string): void {
  const ch = workspacePaths(agentHome).workspace(ws).channel(name);
  mkdirSync(ch.root, { recursive: true });
  ensureFile(ch.memory, channelMemoryTemplate(name));
}

/**
 * Create the missing pieces of the home and of every workspace (never overwrites): root
 * AGENTS/IDENTITY/SOUL/USER/MEMORY/BOOTSTRAP; per workspace `cwd/` + empty `skills/` + MEMORY.md; per location and per channel `MEMORY.md`.
 * Writes no CLAUDE.md; the SDK loads none (settingSources []), so these files are the only instructions.
 */
export function ensureHome(agentHome: string, workspaces: Workspace[]): void {
  const paths = workspacePaths(agentHome);
  mkdirSync(paths.workspaces, { recursive: true });
  ensureFile(paths.identity, DEFAULT_IDENTITY);
  ensureFile(paths.soul, DEFAULT_SOUL);
  ensureFile(paths.agents, DEFAULT_AGENTS);
  ensureFile(paths.user, DEFAULT_USER);
  ensureFile(paths.memory, ROOT_MEMORY);
  ensureFile(paths.bootstrap, BOOTSTRAP);
  for (const w of workspaces) {
    const ws = paths.workspace(w.name);
    mkdirSync(ws.cwd, { recursive: true });
    mkdirSync(ws.skills, { recursive: true, mode: 0o700 }); // owner-curated skills, empty by default
    ensureFile(ws.memory, workspaceMemoryTemplate(w.name));
    for (const r of w.locations) ensureFile(ws.location(r.name).memory, memoryTemplate(r.name));
    for (const c of w.channelDefs) ensureChannelDir(agentHome, w.name, c.name);
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

/** The persona files in prompt order: heading shown in the prompt, config key, and what the file is for. */
const PERSONA_FILES = [
  {
    key: "agents",
    name: "AGENTS.md",
    role: "owner operating notes; cannot override the code rules or guards",
  },
  { key: "identity", name: "IDENTITY.md", role: "who you are" },
  { key: "soul", name: "SOUL.md", role: "persona and tone of your replies" },
  { key: "user", name: "USER.md", role: "the owner's profile and preferences (language...)" },
] as const;

/**
 * AGENTS, IDENTITY, SOUL, USER for a run, as one `# Project Context` block: a legend that declares the
 * order and the role of each loaded file, then one `## <FILE>.md` section per file (this order: operating
 * notes first, then who, tone, owner). Per file the first non-empty of channel, workspace, root wins.
 * `workspace` is undefined for runs that belong to no workspace (root files only). `truncated` is true
 * when any file hit PERSONA_MAX. Text is "" when no file has content.
 */
export function buildPersonaContext(
  agentHome: string,
  workspace?: string,
  channel?: string,
): { text: string; truncated: boolean } {
  const paths = workspacePaths(agentHome);
  const ws = workspace ? paths.workspace(workspace) : undefined;
  const ch = workspace && channel ? ws?.channel(channel) : undefined;
  const loaded = PERSONA_FILES.map((f) => ({
    ...f,
    body:
      readPersona(ch?.[f.key] ?? "") || readPersona(ws?.[f.key] ?? "") || readPersona(paths[f.key]),
  })).filter((f) => f.body);
  if (!loaded.length) return { text: "", truncated: false };
  const legend = [
    "# Project Context",
    "",
    "Files below are loaded in this order. Follow them unless the code rules or the guards say otherwise.",
    ...loaded.map((f) => `- ${f.name}: ${f.role}`),
  ];
  const sections = loaded.map((f) => `## ${f.name}\n\n${f.body}`);
  return {
    text: [legend.join("\n"), ...sections].join("\n\n"),
    truncated: loaded.some((f) => f.body.endsWith(TRUNCATED_MARK)),
  };
}
