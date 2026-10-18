import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { redactText } from "../observability/redact";
import { isInside, resolveReal } from "../policy/paths";
import { isSensitivePath } from "../runtime/sensitive-files";
import { insertArtifact, latestVersion } from "../storage/artifact-store";
import { indexArtifact } from "./artifact-index";
import { type ArtifactKind, isIndexedKind } from "./artifact-kinds";
import { REPORT_REPO_DOC_MAX_BYTES } from "./artifact-limits";
import { type ArtifactInput, assertScope, splitName } from "./artifact-writer";

/** A reference to a file of a granted location: the file stays where it is (never copied). */
export type RepoRefInput = Omit<ArtifactInput, "body" | "kind" | "location"> & {
  kind: ArtifactKind;
  /** The granted location: its name and directory. */
  location: { name: string; path: string };
  /** File path relative to the location. */
  relPath: string;
  /** AGENT_HOME: a file inside it is never referenced (a $HOME location contains it). */
  home: string;
};

/**
 * Register a file of a granted location as an artifact (`origin` repo; the row keeps the location name and the path
 * relative to it). Refused: an absolute path, a path whose real location (symlinks resolved) is outside the location, a
 * missing, non-file or over-limit target, a file inside AGENT_HOME, a sensitive file or dir (`data/sensitive-paths.yaml`: checked on the given and on the real
 * path). Text kinds are indexed from a snapshot of the file now (redacted). Returns the id and the relative path.
 */
export function registerRepoArtifact(
  db: Database,
  a: RepoRefInput,
): { id: string; path: string; version: number } {
  assertScope(a.workspace, a.channel);
  if (isAbsolute(a.relPath)) throw new Error("repo artifact path must be relative");
  const root = resolveReal(a.location.path);
  const real = resolveReal(join(root, a.relPath));
  if (!isInside(root, real)) throw new Error("repo artifact path leaves the location");
  const rel = relative(root, real);
  if (isInside(resolveReal(a.home), real))
    throw new Error("repo artifact path is inside AGENT_HOME");
  if (isSensitivePath(a.relPath) || isSensitivePath(rel))
    throw new Error("repo artifact path is a sensitive file");
  const st = statSync(real); // a missing target throws here
  if (!st.isFile()) throw new Error("repo artifact path is not a file");
  if (st.size > REPORT_REPO_DOC_MAX_BYTES)
    throw new Error(`repo artifact file is over ${REPORT_REPO_DOC_MAX_BYTES} bytes`);
  const { stem, ext } = splitName(
    redactText(a.title ?? "").trim() || rel.split("/").pop(),
    a.kind,
    a.fallbackName,
  );
  const name = `${stem}.${ext}`;
  const channel = a.channel ?? "";
  const version = latestVersion(db, a.workspace, channel, name) + 1;
  const id = crypto.randomUUID();
  insertArtifact(db, {
    id,
    workspace: a.workspace,
    channel,
    goalId: a.goalId ?? null,
    taskId: a.taskId ?? null,
    threadId: a.threadId ?? null,
    title: redactText(a.title ?? "").trim() || rel,
    name,
    kind: a.kind,
    origin: "repo",
    path: rel,
    location: a.location.name,
    producerRole: a.producerRole ?? null,
    version,
    size: st.size,
    sourceMtime: Math.floor(st.mtimeMs),
    summary: 0,
    createdAt: Date.now(),
  });
  if (isIndexedKind(a.kind))
    indexArtifact(
      db,
      { id, workspace: a.workspace, channel },
      redactText(readFileSync(real, "utf8")),
    );
  return { id, path: rel, version };
}
