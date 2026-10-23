import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { ArtifactToolCtx } from "../../artifacts/artifact-access";
import { ARTIFACT_KINDS, type ArtifactKind } from "../../artifacts/artifact-kinds";
import { checkRepoFile, registerRepoArtifact } from "../../artifacts/artifact-repo-ref";
import { writeArtifact } from "../../artifacts/artifact-writer";
import { headingTitle } from "../../ingress/attachment-name";
import { errText, redactText } from "../../observability/redact";
import { taskArtifactsByTitle } from "../../storage/artifact-list-store";
import { getItem } from "../../storage/owned-item-store";
import { lastMessageOf } from "../../storage/task-message-store";
import type { ReportFile } from "../worker/report-files";
import type { Post } from "./effect-port";

/* `Orchestrate forward verbatim` makes the artifacts: the task's result message (md) and each file its report named.
   Workers cannot save artifacts; this is the one place a task's deliverables become artifacts, made again never:
   a second forward finds the rows it made (same task, title and content) and posts them. */

/** What a forward posts, and what it could not (`FILE_GONE` and other per-file notes for the teammate's reply). */
export interface ForwardPlan {
  posts: Post[];
  notes: string[];
}

/** Kind of a path from its extension; undefined for anything that is not a document. */
const kindOf = (path: string): ArtifactKind | undefined => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return (ARTIFACT_KINDS as readonly string[]).includes(ext) ? (ext as ArtifactKind) : undefined;
};

/** A title as the artifact writers store it (redacted, trimmed), so a repeat forward finds its rows. */
const storedTitle = (title: string): string => redactText(title).trim();

/** The reported files of a result message (a corrupt column reads as none). */
function filesOf(json: string | null): ReportFile[] {
  try {
    const v = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(v) ? (v as ReportFile[]) : [];
  } catch {
    return [];
  }
}

/** Text of a file, or undefined when it is gone (ENOENT) or unreadable. */
function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Plan the forward of a task's result: the result message as an md artifact, each named file as an artifact (a scratch
 * file from its copy, a location file as a reference). Returns what to post and the notes, or undefined when the task has
 * no result message. Without an artifact scope (a thread with no channel) the message text is posted inline.
 */
export function planForward(
  db: Database,
  c: ArtifactToolCtx | undefined,
  taskId: string,
): ForwardPlan | undefined {
  const msg = lastMessageOf(db, taskId, "result");
  const item = getItem(db, taskId);
  if (!msg || !item) return undefined;
  if (!c) return { posts: [{ text: msg.text }], notes: [] };
  const goalId = item.parentId ?? taskId;
  const posts: Post[] = [];
  const notes: string[] = [];
  /** Post a stored text as an artifact of the task: reuse a row with the same title, kind and content. */
  const store = (title: string, kind: ArtifactKind, body: string): Post => {
    const text = redactText(body);
    const same = taskArtifactsByTitle(db, taskId, storedTitle(title), "store").find(
      (r) => r.kind === kind && readOrUndefined(r.path) === text,
    );
    const w =
      same ??
      writeArtifact(db, c.home, {
        workspace: c.workspace,
        ...(c.channel && { channel: c.channel }),
        goalId,
        taskId,
        ...(c.threadId && { threadId: c.threadId }),
        ...(item.ownerRole && { producerRole: item.ownerRole }),
        title,
        fallbackName: "result",
        kind,
        body,
      });
    return { filePath: w.path, artifactId: w.id };
  };
  posts.push(store(headingTitle(msg.text) ?? `Result ${item.itemKey ?? "task"}`, "md", msg.text));
  for (const f of filesOf(msg.files)) {
    const kind = kindOf(f.path);
    if (!kind) {
      notes.push(`SKIPPED: "${f.title}" is not a document file.`);
      continue;
    }
    if (f.base === "scratch") {
      const body = readOrUndefined(f.path);
      if (body === undefined) notes.push(`FILE_GONE: "${f.title}" copy is missing; skipped.`);
      else posts.push(store(f.title, kind, body));
      continue;
    }
    const loc = c.locations.find((l) => l.name === f.location);
    if (!loc) {
      notes.push(
        `BAD_LOCATION: "${f.title}" names a location this channel no longer has; skipped.`,
      );
      continue;
    }
    try {
      // The checks run on EVERY forward (a file swapped for a symlink to a secret since the last one is refused); the
      // post reads the checked real path.
      const { real: filePath } = checkRepoFile(loc, f.path, c.home);
      const known = taskArtifactsByTitle(db, taskId, storedTitle(f.title), "repo").find(
        (r) => r.path === f.path,
      );
      const id =
        known?.id ??
        registerRepoArtifact(db, {
          workspace: c.workspace,
          ...(c.channel && { channel: c.channel }),
          goalId,
          taskId,
          ...(c.threadId && { threadId: c.threadId }),
          ...(item.ownerRole && { producerRole: item.ownerRole }),
          title: f.title,
          kind,
          location: loc,
          relPath: f.path,
          home: c.home,
        }).id;
      posts.push({ filePath, artifactId: id });
    } catch (err) {
      const gone = (err as NodeJS.ErrnoException).code === "ENOENT";
      notes.push(
        gone
          ? `FILE_GONE: "${f.title}" (${f.path}) no longer exists in ${loc.name}; skipped.`
          : `REFUSED: "${f.title}": ${errText(err, 120)}; skipped.`,
      );
    }
  }
  return { posts, notes };
}
