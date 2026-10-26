import { randomUUID } from "node:crypto";
import type { FileDto } from "@friday/contracts";
import type { Attachment, FileRef, FileRow, InboundMessage, UploadRow } from "@friday/core";
import { acceptedMimeForName } from "./accepted-types";
import {
  checkObjects,
  checkSendInput,
  downloadChecked,
  MAX_UPLOAD_BYTES,
  UPLOAD_PUT_SECONDS,
} from "./inbound-checks";
import { openInboxDir, writeInboxFile } from "./inbound-inbox";
import { replayStored } from "./inbound-replay";
import { toFileDto, toFileRef } from "./message-dto";
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
  const mime = acceptedMimeForName(i.name);
  if (!mime) throw new SurfaceError("BAD_REQUEST", `${i.name}: this file type is not accepted`);
  const uploadId = randomUUID();
  const name = safeName(i.name);
  const key = `uploads/${i.conversationId}/${uploadId}/${name}`;
  await deps.store.uploads.insert({
    id: uploadId,
    key,
    conversationId: i.conversationId,
    purpose: "chat",
    name,
    mimeType: mime,
    size: i.size,
    state: "pending",
    at: deps.clock.now(),
  });
  return { uploadId, putUrl: deps.files.presignPut(key, UPLOAD_PUT_SECONDS, mime) };
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

/** The inbound message that goes to the handler (shared by a first send and a replay). */
type SendInput = {
  conversationId: string;
  text: string;
  uploadIds?: string[];
  replyTo?: number;
  clientNonce?: string;
};

/** Undo a send that never reached the store: delete the files rows made here, release the uploads. */
async function undoSend(
  deps: WebSurfaceDeps,
  rows: UploadRow[],
  fileRows: FileRow[],
): Promise<void> {
  for (const r of fileRows) await deps.store.files.delete(r.id).catch(() => undefined);
  for (const u of rows) await deps.store.uploads.release(u.id).catch(() => undefined);
}

/**
 * Check every stored object, write the files into a private inbox directory and insert their `files` rows
 * (pushed to `fileRows` as they are made, so a failure can undo them). Returns what the message carries.
 */
async function saveFiles(
  deps: WebSurfaceDeps,
  conversationId: string,
  rows: UploadRow[],
  fileRows: FileRow[],
): Promise<{ files: FileRef[]; attachments: Attachment[] }> {
  const sizes = await checkObjects(deps, rows);
  const data = await downloadChecked(deps, rows, sizes);
  const dir = await openInboxDir(deps.inboxDir, conversationId, deps.clock.now(), rows.length > 0);
  const files: FileRef[] = [];
  const attachments: Attachment[] = [];
  for (const [idx, u] of rows.entries()) {
    const bytes = data[idx] as Uint8Array;
    const { name, path } = await writeInboxFile(dir, idx, safeName(u.name), bytes);
    // Pixel size for images only; unreadable bytes mean no size, never a refusal.
    const dims = u.mimeType.startsWith("image/") ? sizeOf(bytes) : undefined;
    const row: FileRow = {
      id: randomUUID(),
      key: u.key,
      conversationId,
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
  return { files, attachments };
}

/**
 * Check, save and hand over one owner message. Every refusal happens before a file is written.
 * A `clientNonce` that is already stored is a retry: it is handed over again with the stored message's files
 * (`replayStored`; the engine routes it again, idempotently) BEFORE any upload is claimed, so a retry after
 * success never meets CONFLICT. Otherwise uploads are claimed first, so two sends cannot use one upload. A failure before
 * the message is stored releases the uploads (back to pending) and deletes the files rows made here; files
 * already written stay in the inbox, which is swept daily. Once the message is stored, its uploads are marked
 * used and nothing is undone: a later throw (routing) is left to the nonce replay.
 */
export async function sendOwnerMessage(
  deps: WebSurfaceDeps,
  handler: ((m: InboundMessage) => Promise<number | undefined>) | undefined,
  i: SendInput,
): Promise<{ messageId: number; files: FileDto[] }> {
  if (!handler) throw new Error("no handler: the engine is not started");
  const { store } = deps;
  const stored = () =>
    i.clientNonce === undefined
      ? Promise.resolve(undefined)
      : store.messages.byNonce(i.conversationId, i.clientNonce);
  const base = {
    conversationId: i.conversationId,
    text: i.text,
    ...(i.replyTo !== undefined && { replyTo: i.replyTo }),
    ...(i.clientNonce !== undefined && { clientNonce: i.clientNonce }),
  };
  const storedId = await stored();
  if (storedId !== undefined) return replayStored(deps, handler, base, storedId, i.uploadIds ?? []);
  const rows = await checkSendInput(deps, i);
  await claimAll(deps, rows);
  const fileRows: FileRow[] = [];
  let msg: InboundMessage;
  try {
    msg = { ...base, ...(await saveFiles(deps, i.conversationId, rows, fileRows)) };
  } catch (e) {
    await undoSend(deps, rows, fileRows);
    throw e;
  }
  let messageId: number | undefined;
  try {
    messageId = await handler(msg);
  } catch (e) {
    // The handler appends, then routes: a throw may come after the append. With a nonce the stored message
    // tells; then its uploads are used and the replay finishes the routing. Without one nothing can tell.
    // A failed lookup undoes nothing: the message may be stored, and its files must stay (the retry's nonce
    // check finds it; if it was not stored, the retry fails visibly on the still-claimed uploads).
    const id = await stored().catch(() => "unknown" as const);
    if (id === undefined) await undoSend(deps, rows, fileRows);
    else if (id !== "unknown")
      for (const u of rows) await store.uploads.markUsed(u.id, id).catch(() => undefined);
    throw e;
  }
  if (messageId === undefined) {
    await undoSend(deps, rows, fileRows);
    throw new SurfaceError("NOT_FOUND", "conversation not found");
  }
  for (const u of rows) await store.uploads.markUsed(u.id, messageId);
  return { messageId, files: (msg.files ?? []).map(toFileDto) };
}
