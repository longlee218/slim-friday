import type { UploadRow } from "@friday/core";
import { imageType } from "./image-type";
import { SurfaceError } from "./surface-error";
import type { WebSurfaceDeps } from "./web-surface";

/** At most this many files per owner message. */
export const MAX_UPLOAD_FILES = 5;
/** At most this many bytes per owner file (20 MB). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** How long a presigned PUT url works. */
export const UPLOAD_PUT_SECONDS = 600;

/** Refuse the send request before anything is looked up in the file store. */
export async function checkSendInput(
  deps: WebSurfaceDeps,
  i: { conversationId: string; text: string; uploadIds?: string[]; replyTo?: number },
): Promise<UploadRow[]> {
  const ids = i.uploadIds ?? [];
  if (!(await deps.store.conversations.get(i.conversationId))) {
    throw new SurfaceError("NOT_FOUND", "conversation not found");
  }
  if (!i.text.trim() && ids.length === 0) throw new SurfaceError("BAD_REQUEST", "empty message");
  if (i.replyTo !== undefined) {
    const r = await deps.store.messages.get(i.replyTo);
    if (!r || r.conversationId !== i.conversationId) {
      throw new SurfaceError("BAD_REQUEST", "reply to a message of this conversation");
    }
  }
  if (ids.length > MAX_UPLOAD_FILES) {
    throw new SurfaceError("BAD_REQUEST", `at most ${MAX_UPLOAD_FILES} files`);
  }
  if (new Set(ids).size !== ids.length) throw new SurfaceError("BAD_REQUEST", "duplicate upload");
  const rows: UploadRow[] = [];
  for (const id of ids) {
    const u = await deps.store.uploads.get(id);
    // One answer for unknown, avatar and foreign ids: nothing leaks about other conversations.
    if (!u || u.purpose !== "chat" || u.conversationId !== i.conversationId) {
      throw new SurfaceError("NOT_FOUND", "upload not found");
    }
    if (u.state !== "pending") throw new SurfaceError("CONFLICT", "upload already used");
    rows.push(u);
  }
  return rows;
}

/**
 * Check the stored object of each upload (present, within the cap, an image when declared one).
 * Returns the stored size per upload id. An oversized object is deleted with its row.
 */
export async function checkObjects(
  deps: WebSurfaceDeps,
  rows: UploadRow[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const u of rows) {
    const stat = await deps.files.stat(u.key);
    if (!stat) throw new SurfaceError("BAD_REQUEST", "upload not received");
    if (stat.size > MAX_UPLOAD_BYTES) {
      // The browser put more than it declared: drop the object so it cannot be used later.
      await deps.files.delete(u.key).catch(() => undefined);
      await deps.store.uploads.delete(u.id);
      throw new SurfaceError("PAYLOAD_TOO_LARGE", "file too large");
    }
    // A declared image must be that image by its bytes; other types are not sniffed.
    if (
      u.mimeType.startsWith("image/") &&
      imageType(await deps.files.readHead(u.key, 12)) !== u.mimeType
    ) {
      throw new SurfaceError("BAD_REQUEST", "file is not the image it says");
    }
    sizes.set(u.id, stat.size);
  }
  return sizes;
}

/**
 * Download every object and check the bytes we really hold (the object may have been replaced
 * since `stat`): same length as stat, within the cap, an image when declared one.
 * Nothing is written to disk here.
 */
export async function downloadChecked(
  deps: WebSurfaceDeps,
  rows: UploadRow[],
  sizes: Map<string, number>,
): Promise<Uint8Array[]> {
  const all: Uint8Array[] = [];
  for (const u of rows) {
    const bytes = await deps.files.read(u.key);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      await deps.files.delete(u.key).catch(() => undefined);
      await deps.store.uploads.delete(u.id);
      throw new SurfaceError("PAYLOAD_TOO_LARGE", "file too large");
    }
    if (bytes.length !== sizes.get(u.id)) {
      throw new SurfaceError("BAD_REQUEST", "upload changed while checking");
    }
    if (u.mimeType.startsWith("image/") && imageType(bytes.subarray(0, 12)) !== u.mimeType) {
      throw new SurfaceError("BAD_REQUEST", "file is not the image it says");
    }
    all.push(bytes);
  }
  return all;
}
