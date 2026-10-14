import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  CHANNEL_NAME,
  LOCATION_NAME,
  WORKSPACE_NAME,
  workspacePaths,
} from "../../config/workspace-paths";
import { localDay } from "../memory-clock";
import { type Chunk, chunkJournal, chunkMemory } from "./memory-chunker";
import { makeId, type Source } from "./memory-ids";

/** A file bigger than this is not indexed (and not served by Get/Expand). */
export const INDEX_MAX_FILE_BYTES = 512_000;
/** Chunks kept per file (the newest: files grow at the end). */
export const INDEX_MAX_CHUNKS_PER_FILE = 2000;

/** What a path is in the index: which workspace it belongs to ('' = root) and which source. */
export interface FileInfo {
  workspace: string;
  source: Exclude<Source, "summary">;
  location?: string;
  /** Channel name (source `channel`). */
  channel?: string;
  date?: string;
}

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Classify a path under AGENT_HOME as an indexable memory file, or null. ONLY the five known shapes are indexable:
 * root MEMORY.md, workspace MEMORY.md, channel MEMORY.md, location MEMORY.md, journal `memory/YYYY-MM-DD.md`. Anything else
 * (MEMORY.pending.md, AGENTS.md, persona files, other trees) is refused here, whoever asks.
 */
export function classifyFile(home: string, file: string): FileInfo | null {
  const rel = relative(home, file);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const p = rel.split(sep);
  if (p.length === 1 && p[0] === "MEMORY.md") return { workspace: "", source: "root" };
  const ws = p[1] ?? "";
  if (p[0] !== "workspaces" || !WORKSPACE_NAME.test(ws)) return null;
  if (p.length === 3 && p[2] === "MEMORY.md") return { workspace: ws, source: "workspace" };
  const channel = p[3] ?? "";
  if (p.length === 5 && p[2] === "channels" && CHANNEL_NAME.test(channel) && p[4] === "MEMORY.md")
    return { workspace: ws, source: "channel", channel };
  const location = p[3] ?? "";
  if (
    p.length === 5 &&
    p[2] === "locations" &&
    LOCATION_NAME.test(location) &&
    p[4] === "MEMORY.md"
  )
    return { workspace: ws, source: "location", location };
  const date = DATE_FILE.exec(p[3] ?? "")?.[1];
  if (p.length === 4 && p[2] === "memory" && date)
    return { workspace: ws, source: "journal", date };
  return null;
}

/** Prefix of the ids of a file's entries. */
export function idPrefix(info: FileInfo): string {
  if (info.source === "location") return `location/${info.location}`;
  if (info.source === "channel") return `channel/${info.channel}`;
  if (info.source === "journal") return `journal/${info.date}`;
  return info.source;
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Workspace dir names that are valid workspace names. */
export const listWorkspaces = (home: string): string[] =>
  names(workspacePaths(home).workspaces).filter((n) => WORKSPACE_NAME.test(n));

/** Candidate memory files of one workspace (they may not exist): its MEMORY.md, each channel's, each location's, each journal day. */
export function workspaceFiles(home: string, workspace: string): string[] {
  if (!WORKSPACE_NAME.test(workspace)) return [];
  const ws = workspacePaths(home).workspace(workspace);
  return [
    ws.memory,
    ...names(ws.channels)
      .filter((c) => CHANNEL_NAME.test(c))
      .map((c) => ws.channel(c).memory),
    ...names(ws.locations)
      .filter((r) => LOCATION_NAME.test(r))
      .map((r) => ws.location(r).memory),
    ...names(join(ws.root, "memory"))
      .filter((f) => DATE_FILE.test(f))
      .map((f) => join(ws.root, "memory", f)),
  ];
}

export type ReadResult =
  | { ok: true; chunks: Chunk[]; mtimeMs: number; size: number }
  | { ok: false; reason: "missing" | "not_file" | "too_big" };

/**
 * Read and chunk one classified file. Refuses a symlink or a non-regular file and a file over the size cap
 * (reason tells which). Undated bullets get the file's mtime day. Chunks are NOT capped here (the index caps them).
 */
export function readFileChunks(file: string, info: FileInfo): ReadResult {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!st.isFile()) return { ok: false, reason: "not_file" };
  if (st.size > INDEX_MAX_FILE_BYTES) return { ok: false, reason: "too_big" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  const chunks =
    info.source === "journal"
      ? chunkJournal(text, info.date ?? "")
      : chunkMemory(text, localDay(new Date(st.mtimeMs)));
  return { ok: true, chunks, mtimeMs: st.mtimeMs, size: st.size };
}

/** Id of one chunk of a classified file. */
export const chunkId = (info: FileInfo, c: Chunk): string =>
  makeId(idPrefix(info), c.token, c.n, c.hash);
