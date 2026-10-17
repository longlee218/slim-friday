/** Kinds of an artifact, set by code from what the producer gave (never guessed from a file extension). */
export const ARTIFACT_KINDS = ["md", "html", "diff", "csv", "txt"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Kinds whose text is full-text indexed (html and diff are stored but not searched). */
const INDEXED_KINDS: readonly ArtifactKind[] = ["md", "txt", "csv"];

/** True when an artifact of this kind is full-text indexed. */
export const isIndexedKind = (kind: ArtifactKind): boolean => INDEXED_KINDS.includes(kind);
