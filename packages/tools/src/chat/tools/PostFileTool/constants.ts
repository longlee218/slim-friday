/** Send a file from the bot's workspaces or scratch dir to the conversation. */
export const POST_FILE_TOOL = "PostFile";
/** Largest file `PostFile` sends, in bytes (Discord's own cap is near this). */
export const POST_FILE_MAX_BYTES = 8 * 1024 * 1024;
