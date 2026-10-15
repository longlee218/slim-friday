/** Limits and the file set of the `WriteSpaceFile` tool. */

/** The only files the tool writes (fixed names: a path is never built from model text). */
export const SPACE_FILES = ["USER.md", "IDENTITY.md", "AGENTS.md", "SOUL.md", "MEMORY.md"] as const;

/** Max chars of the new content (the prompt reads at most 6000 chars of a persona file). */
export const CONTENT_MAX_CHARS = 6000;
/** Max chars of the diff shown to the owner; a bigger one is refused (the owner must see the whole change). */
export const DIFF_MAX_CHARS = 16000;
/** Unchanged lines shown around each changed line of the diff. */
export const DIFF_CONTEXT_LINES = 2;
/** Above this many line pairs the diff is a plain replace (keeps the diff cost bounded). */
export const DIFF_MAX_CELLS = 1_000_000;
/** Backups kept per target file (older ones are deleted after each new backup). */
export const BACKUP_KEEP = 10;
