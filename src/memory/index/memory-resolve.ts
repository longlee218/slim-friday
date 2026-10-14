import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { WORKSPACE_NAME, workspacePaths } from "../../config/workspace-paths";
import { SUMMARY_MAX_CHARS } from "../../storage/thread-summary-store";
import type { MemoryToolContext } from "../../tools/memory-tool-context";
import { locationTarget, rootTarget, workspaceTarget } from "../memory-targets";
import type { Chunk } from "./memory-chunker";
import { type FileInfo, readFileChunks } from "./memory-files";
import { type ParsedId, parseId } from "./memory-ids";

/** An entry re-read from its current source. */
export interface Resolved {
  /** The entry verbatim. */
  text: string;
  /** Its surrounding section / block (the whole summary for a summary). */
  context: string;
  date: string;
}

/** Text of every "can't resolve" answer: one text for all causes (no existence oracle). */
export const NOT_FOUND = "not found: entry moved or edited. Run MemorySearch again.";

/** The chunk an id points to: same position AND hash, else the same hash elsewhere in the file (moved entry). A different hash (edited / deleted) never resolves; equal hashes mean equal content. */
function pick(
  chunks: Chunk[],
  id: Extract<ParsedId, { type: "file" | "journal" }>,
): Chunk | undefined {
  const same = chunks.filter((c) => c.hash === id.hash);
  return same.find((c) => c.token === id.token && c.n === id.n) ?? same[0];
}

/** File + classification an id points to INSIDE the run's workspace, built by the app's own path builders. */
function fileOf(ctx: MemoryToolContext, id: ParsedId): { file: string; info: FileInfo } | null {
  if (id.type === "file" && id.source === "root")
    return { file: rootTarget(ctx.home).file, info: { workspace: "", source: "root" } };
  if (!WORKSPACE_NAME.test(ctx.workspace)) return null;
  if (id.type === "file" && id.source === "workspace")
    return {
      file: workspaceTarget(ctx.home, ctx.workspace).file,
      info: { workspace: ctx.workspace, source: "workspace" },
    };
  if (id.type === "file" && id.location !== undefined && ctx.locationNames().includes(id.location))
    return {
      file: locationTarget(ctx.home, ctx.workspace, id.location).file,
      info: { workspace: ctx.workspace, source: "location", location: id.location },
    };
  if (id.type === "journal")
    return {
      file: join(workspacePaths(ctx.home).workspace(ctx.workspace).root, "memory", `${id.date}.md`),
      info: { workspace: ctx.workspace, source: "journal", date: id.date },
    };
  return null;
}

/**
 * Re-resolve an id against the CURRENT state. Null = cannot be served (bad id, other workspace, unknown location,
 * file gone / symlink / too big, entry edited or deleted, summary cycle changed): the caller answers NOT_FOUND.
 * Never throws for model input, never opens a path built from the id.
 */
export function resolveEntry(db: Database, ctx: MemoryToolContext, rawId: string): Resolved | null {
  const id = parseId(rawId);
  if (!id) return null;
  if (id.type === "summary") {
    if (ctx.workspace === "") return null; // a summary without a workspace cannot be isolated
    const row = db
      .query<{ summary: string; cycle: number }, [string, string]>(
        "SELECT summary, cycle FROM thread_summaries WHERE thread_id = ? AND workspace = ?",
      )
      .get(id.threadId, ctx.workspace);
    if (!row || row.cycle !== id.cycle || row.summary === "") return null;
    const text = row.summary.slice(0, SUMMARY_MAX_CHARS);
    return { text, context: text, date: "" };
  }
  const where = fileOf(ctx, id);
  if (!where) return null;
  const res = readFileChunks(where.file, where.info);
  if (!res.ok) return null;
  const c = pick(res.chunks, id);
  return c ? { text: c.text, context: c.context, date: c.date } : null;
}
