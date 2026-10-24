import type { FileDto, MessageDto } from "@friday/contracts";
import type { FileRef, FileRow, IndexedMessage } from "@friday/core";

/** Longest quote shown for a replied-to message, in code points. */
const EXCERPT_LENGTH = 140;

/** Image types shown inline (the same list the upload check accepts). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

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
    kind: IMAGE_TYPES.has(f.mimeType) ? "image" : "file",
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
