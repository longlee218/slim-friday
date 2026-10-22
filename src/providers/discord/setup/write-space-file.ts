import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHANNEL_NAME, WORKSPACE_NAME, workspacePaths } from "../../../config/workspace-paths";
import {
  CONTENT_MAX_CHARS,
  DIFF_MAX_CHARS,
  SPACE_FILES,
} from "../../../mcp/discord-admin/tools/WriteSpaceFileTool/constants";
import { reindexFile } from "../../../memory/index/memory-index";
import {
  MemoryBusyError,
  MemorySymlinkError,
  withMemoryLock,
} from "../../../memory/memory-file-lock";
import { logEvent, logger } from "../../../observability/logger";
import { errText, redactText } from "../../../observability/redact";
import { isInside, resolveReal } from "../../../policy/paths";
import { backupPersonaFile } from "../../../workspaces/persona-backup";
import { loadWorkspaces } from "../../../workspaces/workspace-registry";
import type { DiscordAdminContext } from "./discord-admin-context";
import { lineDiff } from "./line-diff";
import { workspaceState } from "./workspace-template";

const log = logger.child({ module: "write-space-file" });

/** What the tool returns to the model: the text, and whether it is an error. */
export interface WriteOutcome {
  text: string;
  error: boolean;
}

/** The memory file name: only a channel has one. */
const MEMORY_FILE = "MEMORY.md";

const refuse = (text: string): WriteOutcome => ({ text, error: true });

/** A resolved target: the file, its backup stem and its label in the diff. */
interface Target {
  path: string;
  /** Real path of the space folder: the write must stay inside it. */
  root: string;
  label: string;
}

/** `lstat` that returns undefined for a missing path (a symlink is reported as itself, never followed). */
function stat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The target file from VALIDATED names only: space and channel match the name rules and exist, the file is one of the
 * fixed names. The channel dir and the file must not be symlinks, and the real path must lie inside the real space
 * folder. Returns the refusal text instead of a target when anything fails.
 */
function resolveTarget(
  home: string,
  a: { space: string; channel?: string; file: string },
): Target | string {
  if (!WORKSPACE_NAME.test(a.space) || workspaceState(home, a.space).kind !== "workspace")
    return "unknown space";
  if (!(SPACE_FILES as readonly string[]).includes(a.file))
    return `file must be one of ${SPACE_FILES.join(", ")}`;
  // The agent's memory is the channel MEMORY.md: a space has no memory file of its own.
  if (a.file === MEMORY_FILE && a.channel === undefined) return "MEMORY.md belongs to a channel";
  const ws = workspacePaths(home).workspace(a.space);
  let dir = ws.root;
  if (a.channel !== undefined) {
    const known = loadWorkspaces(home).workspaces.find((w) => w.name === a.space);
    if (!CHANNEL_NAME.test(a.channel) || !known?.channelDefs.some((c) => c.name === a.channel))
      return "unknown channel";
    dir = ws.channel(a.channel).root;
    const st = stat(dir);
    if (!st?.isDirectory()) return "the channel has no folder"; // a symlink is not a directory for lstat
  }
  const path = join(dir, a.file);
  const st = stat(path);
  if (st && !st.isFile()) return "the target is not a regular file";
  try {
    const root = realpathSync(ws.root);
    if (!isInside(root, resolveReal(path))) return "the target is outside the space folder";
    return { path, root, label: `${a.space}${a.channel ? `/${a.channel}` : ""}/${a.file}` };
  } catch {
    return "the target path cannot be resolved";
  }
}

/** The file's bytes, or an empty buffer when it does not exist. */
function readBytes(path: string): Buffer {
  return stat(path) ? readFileSync(path) : Buffer.alloc(0);
}

/**
 * Lost-update check + backup + 0600 temp-and-rename, all under the file's memory lock. The diff the owner approved was
 * built on `old`: any other bytes on disk now mean another writer won, and nothing is written. Returns the refusal
 * text, or undefined when written.
 */
function lockedWrite(
  ctx: DiscordAdminContext,
  a: { space: string; channel?: string; file: string; content: string },
  path: string,
  old: Buffer,
): string | undefined {
  const tmp = join(dirname(path), `${a.file}.${process.pid}.${randomUUID()}.tmp`);
  try {
    return withMemoryLock(path, () => {
      if (!readBytes(path).equals(old))
        return "the file changed since the diff was shown; run again";
      if (old.length) backupPersonaFile(ctx.home, a, old, (ctx.now ?? (() => new Date()))());
      writeFileSync(tmp, a.content, { mode: 0o600, flag: "wx" });
      renameSync(tmp, path);
      return undefined;
    });
  } catch (err) {
    rmSync(tmp, { force: true });
    if (err instanceof MemoryBusyError)
      return "the file is busy (another write holds it); run again";
    if (err instanceof MemorySymlinkError)
      return "the target is a symlink: refusing to write through it";
    log.warn({ err: errText(err) }, "space file write failed");
    return "write failed (see logs); the old file is unchanged";
  }
}

/**
 * Write one persona/memory file of a space (or channel) after the owner saw the diff and said yes.
 * Order: validate names and path (no side effect) -> content checks -> redacted diff -> owner confirm (fails closed:
 * a no, a timeout or an error writes nothing) -> re-check the path -> under the file lock: lost-update check, backup (newest 10 kept), 0600 temp + rename ->
 * re-index a MEMORY.md for search.
 * Content, diff and the confirm question never reach the log (sizes only).
 */
export async function writeSpaceFile(
  ctx: DiscordAdminContext,
  a: { space: string; channel?: string; file: string; content: string },
): Promise<WriteOutcome> {
  const target = resolveTarget(ctx.home, a);
  if (typeof target === "string") return refuse(target);
  // MEMORY.md has no size cap (owner decision); the diff limit below still applies to every file.
  if (a.file !== MEMORY_FILE && a.content.length > CONTENT_MAX_CHARS)
    return refuse(`content must be text of at most ${CONTENT_MAX_CHARS} chars`);
  if (a.content.includes("\0")) return refuse("content must be text");
  if (redactText(a.content) !== a.content)
    return refuse("the content looks like it holds a secret; remove it and try again");
  const old = readBytes(target.path);
  const diff = lineDiff(old.toString("utf8"), a.content, target.label);
  if (!diff.text) return { text: "no change: the file already has this content", error: false };
  const shown = redactText(diff.text);
  if (shown.length > DIFF_MAX_CHARS)
    return refuse("the change is too large to show; write a shorter file or change less");
  const yes = await ctx.confirm({
    kind: "write_space_file",
    summary: `Write ${target.label}: +${diff.added} -${diff.removed} lines. The diff is attached; apply it?`,
    detail: shown,
  });
  if (!yes) {
    logEvent(log, "space_file.declined", { file: a.file });
    return { text: "not written: the owner declined or did not answer", error: false };
  }
  // The owner took time to answer: the path is checked again right before the write.
  const again = resolveTarget(ctx.home, a);
  if (typeof again === "string") return refuse(again);
  // Under the memory file lock (the same lock `MemorySave` and the owner memory commands take), so no other writer can
  // slip in between the lost-update check and the rename.
  const failed = lockedWrite(ctx, a, again.path, old);
  if (failed) return refuse(failed);
  // A MEMORY.md is searchable at once (MemorySearch); other files are not indexed (reindexFile skips them).
  if (ctx.db) {
    try {
      reindexFile(ctx.db, ctx.home, again.path);
    } catch (err) {
      log.warn({ err: errText(err) }, "space file reindex failed");
    }
  }
  logEvent(log, "space_file.written", {
    file: a.file,
    channel: !!a.channel,
    chars: a.content.length,
  });
  return {
    text: `written ${target.label} (${a.content.length} chars; old file backed up)`,
    error: false,
  };
}
