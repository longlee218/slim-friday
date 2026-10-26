/** Upload types the app accepts: extension (with dot, lowercase) to mime. Same table as the surface package (a test keeps them equal). */
export const ACCEPTED_FILE_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** The mime for a file name by its last extension (case-insensitive), or `undefined` when refused. */
export function acceptedMimeForName(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 1) return undefined;
  return ACCEPTED_FILE_TYPES[name.slice(dot).toLowerCase()];
}

/** Comma-joined extensions for `<input accept>`. */
export const FILE_ACCEPT_ATTRIBUTE: string = Object.keys(ACCEPTED_FILE_TYPES).join(",");
