import type { Database } from "bun:sqlite";
import { CHANNEL_NAME, WORKSPACE_NAME, workspacePaths } from "../config/workspace-paths";
import { attachmentName } from "../ingress/attachment-name";
import { redactText } from "../observability/redact";
import { insertArtifact, latestVersion } from "../storage/artifact-store";
import { indexArtifact } from "./artifact-index";
import { type ArtifactKind, isIndexedKind } from "./artifact-kinds";
import { writeFileExclusive } from "./safe-write";

/** Most file names tried for one save (each taken name moves to the next version). */
const MAX_VERSION_TRIES = 1000;

/** What a producer gives for one artifact. */
export interface ArtifactInput {
  /** Space of the run; the file goes to its channel dir, or its workspace-level dir when `channel` is absent. */
  workspace: string;
  /** Channel (yaml name) of the run; absent = no mapped channel. */
  channel?: string;
  /** Lookup columns only: they never decide where the file lives. */
  goalId?: string;
  taskId?: string;
  threadId?: string;
  /** The producer's title: the file name is its ASCII slug (`attachmentName`). */
  title?: string;
  /** Name stem used when the title gives no slug. */
  fallbackName?: string;
  kind: ArtifactKind;
  /** Body; redacted here again, whatever the caller did. */
  body: string;
  producerRole?: string;
  /** Location name of a repo artifact. */
  location?: string;
  /** True for the code-written result summary of a task: it is never counted as a file the run saved itself. */
  summary?: boolean;
}

/** Name (`attachmentName` of the title) split into stem and extension. */
export function splitName(title: string | undefined, kind: ArtifactKind, fallback?: string) {
  const full = attachmentName(title, kind, { ...(fallback && { fallback }) });
  const dot = full.lastIndexOf(".");
  return { stem: full.slice(0, dot), ext: full.slice(dot + 1) };
}

/** Throw unless the workspace and channel names are safe dir names (they come from yaml; never trust a path piece). */
export function assertScope(workspace: string, channel?: string): void {
  if (!WORKSPACE_NAME.test(workspace)) throw new Error(`bad workspace name: ${workspace}`);
  if (channel !== undefined && !CHANNEL_NAME.test(channel))
    throw new Error(`bad channel name: ${channel}`);
}

/**
 * Write a document artifact: `workspaces/<ws>/channels/<channel>/artifacts/<title-slug>[-vN].<ext>` (workspace-level
 * `artifacts/` when no channel), redacted, atomic, owner-only; one `artifacts` row; text kinds are full-text indexed.
 * The same name in the same channel makes a new `-vN` file and row: the older ones stay. Returns the id, path and version.
 */
export function writeArtifact(
  db: Database,
  agentHome: string,
  a: ArtifactInput,
): { id: string; path: string; version: number } {
  assertScope(a.workspace, a.channel);
  const ws = workspacePaths(agentHome).workspace(a.workspace);
  const dir = a.channel ? ws.channel(a.channel).artifacts : ws.artifacts;
  const { stem, ext } = splitName(
    redactText(a.title ?? "").trim() || undefined,
    a.kind,
    a.fallbackName,
  );
  const name = `${stem}.${ext}`;
  const channel = a.channel ?? "";
  let version = latestVersion(db, a.workspace, channel, name) + 1;
  const fileOf = (v: number) => `${stem}${v > 1 ? `-v${v}` : ""}.${ext}`;
  const body = redactText(a.body);
  // A file already on disk (db and disk can differ, two saves can race) is never overwritten: the exclusive publish
  // fails on a taken name and the next version is tried (bounded).
  let path: string | null = null;
  for (let i = 0; i < MAX_VERSION_TRIES && path === null; i++) {
    path = writeFileExclusive(agentHome, dir, fileOf(version), body);
    if (path === null) version++;
  }
  if (path === null) throw new Error(`no free file name for artifact ${name}`);
  const id = crypto.randomUUID();
  insertArtifact(db, {
    id,
    workspace: a.workspace,
    channel,
    goalId: a.goalId ?? null,
    taskId: a.taskId ?? null,
    threadId: a.threadId ?? null,
    title: redactText(a.title ?? "").trim() || stem,
    name,
    kind: a.kind,
    origin: "store",
    path,
    location: a.location ?? null,
    producerRole: a.producerRole ?? null,
    version,
    size: Buffer.byteLength(body),
    sourceMtime: null,
    summary: a.summary ? 1 : 0,
    createdAt: Date.now(),
  });
  if (isIndexedKind(a.kind)) indexArtifact(db, { id, workspace: a.workspace, channel }, body);
  return { id, path, version };
}
