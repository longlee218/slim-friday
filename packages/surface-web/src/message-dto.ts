import type { FileDto, MessageDto } from "@friday/contracts";
import type { FileRef, FileRow, IndexedMessage } from "@friday/core";

/** Longest quote shown for a replied-to message, in code points. */
const EXCERPT_LENGTH = 140;

/** Image types shown inline (the same list the upload check accepts). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** True when a stored mime type is one of the inline image types. */
export const isImageType = (mimeType: string): boolean => IMAGE_TYPES.has(mimeType);

/** Collapse whitespace to one line, then cut to `EXCERPT_LENGTH` code points. */
function excerptOf(text: string): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, EXCERPT_LENGTH).join("");
}

/** A stored file reference as the contract's file. */
function toFileDto(f: FileRef): FileDto {
  return {
    id: f.fileId,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    kind: isImageType(f.mimeType) ? "image" : "file",
    ...(f.width !== undefined && { width: f.width }),
    ...(f.height !== undefined && { height: f.height }),
  };
}

/** A stored message as the contract's message; `replied` is the message `m.replyTo` points at. */
export function toMessageDto(m: IndexedMessage, replied?: IndexedMessage): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    author: m.author,
    kind: m.kind ?? "text",
    text: m.text,
    at: m.at,
    files: (m.files ?? []).map(toFileDto),
    ...(replied && {
      replyTo: {
        messageId: replied.id,
        ...(replied.author.kind === "bot" && { botId: replied.author.botId }),
        excerpt: excerptOf(replied.text),
      },
    }),
    ...(m.run && { run: m.run }),
    ...(m.relay && { relay: m.relay }),
    // A message whose schedule was already gone at run start has no name, so no tag.
    ...(m.scheduleId && m.scheduleName && { schedule: { id: m.scheduleId, name: m.scheduleName } }),
  };
}

/** A stored file row as the reference a message carries. */
export function toFileRef(row: FileRow): FileRef {
  return {
    fileId: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    ...(row.width !== undefined && { width: row.width }),
    ...(row.height !== undefined && { height: row.height }),
  };
}
