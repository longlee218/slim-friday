import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { redactText } from "../observability/redact";
import { ftsDelete, setSourceSnapshot } from "../storage/artifact-list-store";
import type { ArtifactRow } from "../storage/artifact-store";
import { indexArtifact } from "./artifact-index";
import { type ArtifactKind, isIndexedKind } from "./artifact-kinds";
import { REPORT_REPO_DOC_MAX_BYTES } from "./artifact-limits";

/**
 * A repo artifact is a reference: its file may change after it was registered. Read the file now (redacted) and, when its
 * mtime differs from the snapshot the index was built from, index it again (old rows out, new rows in, size and mtime
 * recorded; one transaction). Returns the current text, or null when the file is over the size limit. `real` is the already validated real path of the file.
 */
export function readRepoText(db: Database, row: ArtifactRow, real: string): string | null {
  const st = statSync(real);
  if (st.size > REPORT_REPO_DOC_MAX_BYTES) return null;
  const text = redactText(readFileSync(real, "utf8"));
  const mtime = Math.floor(st.mtimeMs);
  if (mtime !== row.sourceMtime) {
    db.transaction(() => {
      ftsDelete(db, row.id);
      if (isIndexedKind(row.kind as ArtifactKind))
        indexArtifact(db, { id: row.id, workspace: row.workspace, channel: row.channel }, text);
      setSourceSnapshot(db, row.id, st.size, mtime);
    })();
  }
  return text;
}
