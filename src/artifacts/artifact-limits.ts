/** Artifact limits (a limit file: every exported number is drift-checked against docs/limits-and-stop-conditions.md). */

/** Size of one FTS row of an artifact body, in chars: the body is split at paragraph borders, no artifact size cap. */
export const ARTIFACT_CHUNK_CHARS = 2000;

/** Chars of one `ReadArtifact` page: bounds ONE tool result (context), never the artifact (any length is read page by page). */
export const ARTIFACT_READ_PAGE_CHARS = 8000;
/** Hits one `SearchArtifacts` call returns when the model gives no limit. */
export const ARTIFACT_SEARCH_DEFAULT_LIMIT = 8;
/** Most hits one `SearchArtifacts` call may return. */
export const ARTIFACT_SEARCH_MAX_LIMIT = 20;
/** Most rows one `ListArtifacts` call returns (newest first). */
export const ARTIFACT_LIST_MAX = 50;
/** Most artifacts one `ReportResult` may reference. */
export const REPORT_ARTIFACTS_MAX = 10;
/** Largest repo file (bytes) a repo artifact may reference or read: a bigger file is refused at register and read as metadata only. */
export const REPORT_REPO_DOC_MAX_BYTES = 2_000_000;
