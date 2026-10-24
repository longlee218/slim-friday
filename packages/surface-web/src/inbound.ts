import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, FileRef, FileRow, InboundMessage } from "@friday/core";
import {
  checkObjects,
  checkSendInput,
  MAX_UPLOAD_BYTES,
  UPLOAD_PUT_SECONDS,
} from "./inbound-checks";
import { toFileRef } from "./message-dto";
import { safeName } from "./safe-name";
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

/**
 * Check, save and hand over one owner message. Every refusal happens before a file is downloaded
 * or written. If a write or the handler fails, uploads stay pending (files already written stay
 * in the inbox, which is swept daily).
 */
export async function sendOwnerMessage(
  deps: WebSurfaceDeps,
  handler: ((m: InboundMessage) => Promise<number | undefined>) | undefined,
  i: { conversationId: string; text: string; uploadIds?: string[]; replyTo?: number },
): Promise<{ messageId: number }> {
  if (!handler) throw new Error("no handler: the engine is not started");
  const rows = await checkSendInput(deps, i);
  const sizes = await checkObjects(deps, rows);
  const dir = join(deps.inboxDir, i.conversationId, String(deps.clock.now()));
  if (rows.length > 0) {
    // Create the directories private; mkdir's mode is masked by umask, so chmod after.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(join(deps.inboxDir, i.conversationId), 0o700);
    await chmod(dir, 0o700);
  }
  const files: FileRef[] = [];
  const attachments: Attachment[] = [];
  const fileRows: FileRow[] = [];
  for (const [idx, u] of rows.entries()) {
    const bytes = await deps.files.read(u.key);
    const name = `${idx + 1}-${safeName(u.name)}`;
    const path = join(dir, name);
    // `wx`: never overwrite or follow an existing file.
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const size = sizes.get(u.id) ?? bytes.length;
    const row: FileRow = {
      id: randomUUID(),
      key: u.key,
      conversationId: i.conversationId,
      name: safeName(u.name),
      mimeType: u.mimeType,
      size,
      source: "upload",
      at: deps.clock.now(),
    };
    fileRows.push(row);
    files.push(toFileRef(row));
    attachments.push({ name, mimeType: u.mimeType, path, size });
  }
  for (const r of fileRows) await deps.store.files.insert(r);
  const messageId = await handler({
    conversationId: i.conversationId,
    text: i.text,
    ...(i.replyTo !== undefined && { replyTo: i.replyTo }),
    files,
    attachments,
  });
  if (messageId === undefined) throw new SurfaceError("NOT_FOUND", "conversation not found");
  for (const u of rows) await deps.store.uploads.markUsed(u.id, messageId);
  return { messageId };
}
