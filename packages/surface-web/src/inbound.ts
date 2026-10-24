import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Attachment, FileRef, FileRow, InboundMessage, UploadRow } from "@friday/core";
import {
  checkObjects,
  checkSendInput,
  downloadChecked,
  MAX_UPLOAD_BYTES,
  UPLOAD_PUT_SECONDS,
} from "./inbound-checks";
import { toFileRef } from "./message-dto";
import { safeName } from "./safe-name";
import { sizeOf } from "./size-of";
import { SurfaceError } from "./surface-error";
import type { WebSurfaceDeps } from "./web-surface";

/** Hand out an upload slot: a pending row and a presigned PUT url for a key made here. */
export async function createUpload(
  deps: WebSurfaceDeps,
  i: { conversationId: string; name: string; type: string; size: number },
): Promise<{ uploadId: string; putUrl: string }> {
  if (!(await deps.store.conversations.get(i.conversationId))) {
    throw new SurfaceError("NOT_FOUND", "conversation not found");
  }
  if (i.size > MAX_UPLOAD_BYTES) throw new SurfaceError("PAYLOAD_TOO_LARGE", "file too large");
  if (!(i.size > 0)) throw new SurfaceError("BAD_REQUEST", "empty file");
  const uploadId = randomUUID();
  const name = safeName(i.name);
  const key = `uploads/${i.conversationId}/${uploadId}/${name}`;
  await deps.store.uploads.insert({
    id: uploadId,
    key,
    conversationId: i.conversationId,
    purpose: "chat",
    name,
    mimeType: i.type,
    size: i.size,
    state: "pending",
    at: deps.clock.now(),
  });
  return { uploadId, putUrl: deps.files.presignPut(key, UPLOAD_PUT_SECONDS, i.type) };
}

/** Take every upload (pending -> claimed) or none: a second send of the same id is a CONFLICT. */
async function claimAll(deps: WebSurfaceDeps, rows: UploadRow[]): Promise<void> {
  const taken: UploadRow[] = [];
  for (const u of rows) {
    if (!(await deps.store.uploads.claim(u.id))) {
      for (const t of taken) await deps.store.uploads.release(t.id);
      throw new SurfaceError("CONFLICT", "upload already used");
    }
    taken.push(u);
  }
}

/**
 * Check, save and hand over one owner message. Every refusal happens before a file is written.
 * Uploads are claimed first, so two sends cannot use one upload. On any failure the uploads are
 * released (back to pending) and the files rows made here are deleted; files already written stay
 * in the inbox, which is swept daily.
 */
export async function sendOwnerMessage(
  deps: WebSurfaceDeps,
  handler: ((m: InboundMessage) => Promise<number | undefined>) | undefined,
  i: {
    conversationId: string;
    text: string;
    uploadIds?: string[];
    replyTo?: number;
    clientNonce?: string;
  },
): Promise<{ messageId: number }> {
  if (!handler) throw new Error("no handler: the engine is not started");
  const rows = await checkSendInput(deps, i);
  await claimAll(deps, rows);
  const fileRows: FileRow[] = [];
  let messageId: number | undefined;
  try {
    const sizes = await checkObjects(deps, rows);
    const data = await downloadChecked(deps, rows, sizes);
    // Unique per send, so two sends in the same millisecond never share a directory.
    const dir = join(
      deps.inboxDir,
      i.conversationId,
      `${deps.clock.now()}-${randomUUID().slice(0, 8)}`,
    );
    // Defense in depth: the directory must stay inside the inbox.
    if (!resolve(dir).startsWith(`${resolve(deps.inboxDir)}${sep}`)) {
      throw new SurfaceError("BAD_REQUEST", "bad conversation id");
    }
    const files: FileRef[] = [];
    const attachments: Attachment[] = [];
    if (rows.length > 0) {
      // Create the directories private; mkdir's mode is masked by umask, so chmod after.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dirname(dir), 0o700);
      await chmod(dir, 0o700);
    }
    for (const [idx, u] of rows.entries()) {
      const bytes = data[idx] as Uint8Array;
      const name = `${idx + 1}-${safeName(u.name)}`;
      const path = join(dir, name);
      // `wx`: never overwrite or follow an existing file.
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      // Pixel size for images only; unreadable bytes mean no size, never a refusal.
      const dims = u.mimeType.startsWith("image/") ? sizeOf(bytes) : undefined;
      const row: FileRow = {
        id: randomUUID(),
        key: u.key,
        conversationId: i.conversationId,
        name: safeName(u.name),
        mimeType: u.mimeType,
        size: bytes.length,
        ...dims,
        source: "upload",
        at: deps.clock.now(),
      };
      await deps.store.files.insert(row);
      fileRows.push(row);
      files.push(toFileRef(row));
      attachments.push({ name, mimeType: u.mimeType, path, size: bytes.length });
    }
    messageId = await handler({
      conversationId: i.conversationId,
      text: i.text,
      ...(i.replyTo !== undefined && { replyTo: i.replyTo }),
      ...(i.clientNonce !== undefined && { clientNonce: i.clientNonce }),
      files,
      attachments,
    });
    if (messageId === undefined) throw new SurfaceError("NOT_FOUND", "conversation not found");
  } catch (e) {
    for (const r of fileRows) await deps.store.files.delete(r.id).catch(() => undefined);
    for (const u of rows) await deps.store.uploads.release(u.id).catch(() => undefined);
    throw e;
  }
  for (const u of rows) await deps.store.uploads.markUsed(u.id, messageId);
  return { messageId };
}
