import type { FileLibraryItemDto } from "@friday/contracts";
import type { FileCursor, FileRow } from "@friday/core";
import { isImageType } from "@friday/surface-web";

/** The opaque cursor a client sends back: the last row of a page. */
export const encodeFileCursor = (c: FileCursor): string =>
  Buffer.from(JSON.stringify({ at: c.at, id: c.id })).toString("base64url");

/** The position a cursor names, or undefined when it is not one we issued. */
export function decodeFileCursor(s: string): FileCursor | undefined {
  try {
    const r: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof r !== "object" || r === null) return undefined;
    const { at, id } = r as Record<string, unknown>;
    return Number.isInteger(at) && typeof id === "string" && id !== ""
      ? { at: at as number, id }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A stored upload as the library's item. */
export function toFileLibraryItem(f: FileRow): FileLibraryItemDto {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    kind: isImageType(f.mimeType) ? "image" : "file",
    ...(f.width !== undefined && { width: f.width }),
    ...(f.height !== undefined && { height: f.height }),
    conversationId: f.conversationId,
    at: f.at,
  };
}
