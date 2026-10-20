import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { demoteHeadings } from "../text/demote-headings";
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

/** Max chars kept of one persona file (4 files => at most 32000 chars of persona). */
export const PERSONA_MAX = 8000;
/** Share of PERSONA_MAX kept from the head of a cut file; the rest comes from its tail (rules first, recent notes last). */
const HEAD_SHARE = 0.7;
/** Start of the marker put where a persona file was cut. */
const CUT_MARK = "[... ";

/**
 * Cut `body` to about `max` chars: 70% from the head and 30% from the tail, both ending on a line border, with a marker
 * in the middle naming the file and the chars removed (the model sees the cut, the owner learns to shorten the file).
 */
export function cutMiddle(body: string, max: number, name: string): string {
  if (body.length <= max) return body;
  const headRaw = body.slice(0, Math.floor(max * HEAD_SHARE));
  const head = headRaw.slice(0, Math.max(headRaw.lastIndexOf("\n"), 0)) || headRaw;
  const tailStart = body.length - (max - Math.floor(max * HEAD_SHARE));
  const tailRaw = body.slice(tailStart);
  const nl = tailRaw.indexOf("\n");
  const onBorder = body[tailStart - 1] === "\n";
  const tail = !onBorder && nl >= 0 && nl < tailRaw.length - 1 ? tailRaw.slice(nl + 1) : tailRaw;
  const cut = body.length - head.length - tail.length;
  return `${head}\n${CUT_MARK}${cut} chars cut from the middle of ${name}; keep it shorter ...]\n${tail}`;
}

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

/** A missing or empty persona file. */
const NONE = { body: "", cut: false };

/**
 * Read a persona file for the prompt: HTML comments stripped, "" when missing, comment-only or
 * heading-only (a template), else cut to PERSONA_MAX (`cutMiddle`).
 */
function readPersona(file: string, name: string): { body: string; cut: boolean } {
  try {
    if (!existsSync(file)) return NONE;
    const body = readFileSync(file, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (!body || /^#[^\n]*$/.test(body)) return NONE;
    return { body: cutMiddle(body, PERSONA_MAX, name), cut: body.length > PERSONA_MAX };
  } catch {
    return NONE;
  }
}

/** The persona files in prompt order (config key and heading): operating notes, then who, tone, owner. */
const PERSONA_FILES = [
  { key: "agents", name: "AGENTS.md" },
  { key: "identity", name: "IDENTITY.md" },
  { key: "soul", name: "SOUL.md" },
  { key: "user", name: "USER.md" },
] as const;

/**
 * The lead's persona block: `## TEAM.md` (`team`, built by code: roster and locations) when given, then `## AGENTS.md`,
 * `## IDENTITY.md`, `## SOUL.md`, `## USER.md`, one section per non-empty file. The work block (TEAM) comes first, then the
 * owner's files. Each file's own headings are pushed two levels down, so they nest under its `## <FILE>.md` heading.
 * Per file the first non-empty of channel, workspace, root wins; `workspace` undefined = root files only (the control
 * channel). `truncated` is true when any file was cut. Text is "" when no section has content.
 */
export function buildPersonaContext(
  agentHome: string,
  workspace?: string,
  channel?: string,
  team?: string,
): { text: string; truncated: boolean } {
  const paths = workspacePaths(agentHome);
  const ws = workspace ? paths.workspace(workspace) : undefined;
  const ch = workspace && channel ? ws?.channel(channel) : undefined;
  // First non-empty of channel, workspace, root.
  const read = (f: (typeof PERSONA_FILES)[number]) =>
    [ch?.[f.key], ws?.[f.key], paths[f.key]]
      .map((file) => (file ? readPersona(file, f.name) : NONE))
      .find((r) => r.body) ?? NONE;
  const files = PERSONA_FILES.map((f) => ({ name: f.name, ...read(f) }));
  const loaded = [...(team ? [{ name: "TEAM.md", body: team }] : []), ...files].filter(
    (f): f is { name: string; body: string } => Boolean(f?.body),
  );
  return {
    text: loaded.map((f) => `## ${f.name}\n\n${demoteHeadings(f.body, 2)}`).join("\n\n"),
    truncated: files.some((f) => f.cut),
  };
}
