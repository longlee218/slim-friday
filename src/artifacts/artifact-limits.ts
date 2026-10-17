/** Artifact limits (a limit file: every exported number is drift-checked against docs/limits-and-stop-conditions.md). */

/** Size of one FTS row of an artifact body, in chars: the body is split at paragraph borders, no artifact size cap. */
export const ARTIFACT_CHUNK_CHARS = 2000;
