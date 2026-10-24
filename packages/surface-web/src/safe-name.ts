/** A file name safe for an R2 key: last path part, odd chars become `_`, at most 100, never empty. */
export function safeName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? "";
  return last.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "file";
}
