/** Files per chat message. */
export const MAX_FILES_PER_MESSAGE = 5;
/** Bytes per uploaded file (20 MB). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Bytes per avatar upload (2 MB). */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
/** Characters in USER.md or SOUL.md. */
export const MAX_OWNER_FILE_CHARS = 20_000;
/** Rules per bot or group. */
export const MAX_RULES = 50;
/** Characters per rule. */
export const MAX_RULE_CHARS = 500;
/** Largest page a list call may ask for. */
export const MAX_PAGE = 100;
/** Most wakes one `ops.wakes` call returns (newest first). */
export const MAX_WAKES = 200;
