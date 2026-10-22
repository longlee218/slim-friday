import { errText } from "../observability/redact";
import { type ArtifactToolCtx, scopedArtifact } from "./artifact-access";
import { ARTIFACT_KINDS, type ArtifactKind } from "./artifact-kinds";
import { registerRepoArtifact } from "./artifact-repo-ref";

/** One artifact a worker names in its report: an id of `SaveArtifact`, or a doc it wrote in its granted location. */
export type ArtifactRef = { id: string } | { title: string; path: string };

/** Kind of a repo doc from its extension (md, html, diff, csv, txt); undefined for anything else (code is not a document). */
function kindOfPath(path: string): ArtifactKind | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (ARTIFACT_KINDS as readonly string[]).includes(ext) ? (ext as ArtifactKind) : undefined;
}

/**
 * Check the refs of a report: an id must be an artifact of the run's channel; a `{title, path}` is registered as a repo
 * artifact of the run's granted location (refused: no granted location, a path outside it, a sensitive or missing file).
 * Returns the ids in order, or the refused entries with the reason (the report is then NOT stored: the worker fixes it).
 */
export function resolveRefs(
  c: ArtifactToolCtx,
  refs: ArtifactRef[],
): { ids: string[] } | { errors: string[] } {
  const ids: string[] = [];
  const errors: string[] = [];
  // One transaction: when any entry is refused, the registrations of the others roll back (a refused report leaves no rows).
  const run = c.db.transaction(() => {
    check(c, refs, ids, errors);
    if (errors.length) throw ROLLBACK;
  });
  try {
    run();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return errors.length ? { errors } : { ids };
}

/** Thrown inside the transaction of `resolveRefs` to undo it; never leaves the module. */
const ROLLBACK = Symbol("refs-rollback");

/** Check every ref, collecting ids and errors (a `{title, path}` is registered as a side effect). */
function check(c: ArtifactToolCtx, refs: ArtifactRef[], ids: string[], errors: string[]): void {
  refs.forEach((r, i) => {
    if ("id" in r) {
      if (scopedArtifact(c, r.id)) ids.push(r.id);
      else errors.push(`artifacts[${i}]: no artifact ${r.id} in this channel`);
      return;
    }
    if (!c.granted) {
      errors.push(`artifacts[${i}]: this run has no granted location for a repo doc`);
      return;
    }
    const kind = kindOfPath(r.path);
    if (!kind) {
      errors.push(
        `artifacts[${i}] ${r.path}: a repo artifact is a document (${ARTIFACT_KINDS.join(", ")}); code files are not artifacts: describe them in the summary`,
      );
      return;
    }
    try {
      const reg = registerRepoArtifact(c.db, {
        workspace: c.workspace,
        ...(c.channel && { channel: c.channel }),
        ...(c.goalId && { goalId: c.goalId }),
        ...(c.taskId && { taskId: c.taskId }),
        ...(c.threadId && { threadId: c.threadId }),
        ...(c.role && { producerRole: c.role }),
        title: r.title,
        kind,
        location: c.granted,
        relPath: r.path,
        home: c.home,
      });
      ids.push(reg.id);
    } catch (err) {
      errors.push(`artifacts[${i}] ${r.path}: ${errText(err, 120)}`);
    }
  });
}
