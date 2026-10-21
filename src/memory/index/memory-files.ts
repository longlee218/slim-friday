import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { CHANNEL_NAME, WORKSPACE_NAME, workspacePaths } from "../../config/workspace-paths";
import { localDay } from "../memory-clock";
import { type Chunk, chunkJournal, chunkMemory } from "./memory-chunker";
import { makeId, type Source } from "./memory-ids";

/** What a path is in the index: which workspace it belongs to ('' = root) and which source. */
export interface FileInfo {
  workspace: string;
  source: Exclude<Source, "summary">;
  /** Channel name (sources `channel` and `journal`). */
  channel?: string;
  date?: string;
}

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Classify a path under AGENT_HOME as an indexable memory file, or null. ONLY the three known shapes are indexable:
 * root MEMORY.md, channel MEMORY.md, channel journal `channels/<ch>/memory/YYYY-MM-DD.md`. Anything else (the retired workspace and
 * location MEMORY.md files, a pending queue file, AGENTS.md, persona files, other trees) is refused here, whoever asks.
 */
export function classifyFile(home: string, file: string): FileInfo | null {
  const rel = relative(home, file);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const p = rel.split(sep);
  if (p.length === 1 && p[0] === "MEMORY.md") return { workspace: "", source: "root" };
  const ws = p[1] ?? "";
  if (p[0] !== "workspaces" || !WORKSPACE_NAME.test(ws)) return null;
  const channel = p[3] ?? "";
  if (p.length === 5 && p[2] === "channels" && CHANNEL_NAME.test(channel) && p[4] === "MEMORY.md")
    return { workspace: ws, source: "channel", channel };
  // Journal day file: workspaces/<ws>/channels/<ch>/memory/YYYY-MM-DD.md (the old workspace memory/ dir is not indexed).
  const date = DATE_FILE.exec(p[5] ?? "")?.[1];
  if (
    p.length === 6 &&
    p[2] === "channels" &&
    CHANNEL_NAME.test(channel) &&
    p[4] === "memory" &&
    date
  )
    return { workspace: ws, source: "journal", channel, date };
  return null;
}

/** Prefix of the ids of a file's entries. */
function idPrefix(info: FileInfo): string {
  if (info.source === "channel") return `channel/${info.channel}`;
  if (info.source === "journal") return `journal/${info.channel}/${info.date}`;
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

/** Valid channel dir names of a workspace's `channels/` dir. */
export const channelDirs = (channelsDir: string): string[] =>
  names(channelsDir).filter((c) => CHANNEL_NAME.test(c));

/** Candidate memory files of one workspace (they may not exist): each channel's MEMORY.md and journal days. */
export function workspaceFiles(home: string, workspace: string): string[] {
  if (!WORKSPACE_NAME.test(workspace)) return [];
  const ws = workspacePaths(home).workspace(workspace);
  return channelDirs(ws.channels).flatMap((c) => {
    const ch = ws.channel(c);
    return [
      ch.memory,
      ...names(ch.journalDir)
        .filter((f) => DATE_FILE.test(f))
        .map((f) => join(ch.journalDir, f)),
    ];
  });
}

export type ReadResult =
  | { ok: true; chunks: Chunk[]; mtimeMs: number; size: number }
  | { ok: false; reason: "missing" | "not_file" };

/**
 * Read and chunk one classified file. Refuses a symlink or a non-regular file (no size cap: memory files have none, a big MEMORY.md is
 * searchable). Undated bullets get the file's mtime day. Chunks are NOT capped here (the index caps them).
 */
export function readFileChunks(file: string, info: FileInfo): ReadResult {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!st.isFile()) return { ok: false, reason: "not_file" };
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
