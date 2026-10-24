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
  // Unique per send, so two sends in the same millisecond never share a directory.
  const dir = join(
    deps.inboxDir,
    conversationId,
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
 * A `clientNonce` that is already stored is a retry: it is handed over again (the engine replays the stored
 * message and routes it again, idempotently) BEFORE any upload is claimed, so a retry after success never
 * meets CONFLICT. Otherwise uploads are claimed first, so two sends cannot use one upload. A failure before
 * the message is stored releases the uploads (back to pending) and deletes the files rows made here; files
 * already written stay in the inbox, which is swept daily. Once the message is stored, its uploads are marked
 * used and nothing is undone: a later throw (routing) is left to the nonce replay.
 */
export async function sendOwnerMessage(
  deps: WebSurfaceDeps,
  handler: ((m: InboundMessage) => Promise<number | undefined>) | undefined,
  i: SendInput,
): Promise<{ messageId: number }> {
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
  if ((await stored()) !== undefined) {
    const id = await handler({ ...base, files: [], attachments: [] });
    if (id === undefined) throw new SurfaceError("NOT_FOUND", "conversation not found");
    return { messageId: id };
  }
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
    const id = await stored().catch(() => undefined);
    if (id === undefined) await undoSend(deps, rows, fileRows);
    else for (const u of rows) await store.uploads.markUsed(u.id, id).catch(() => undefined);
    throw e;
  }
  if (messageId === undefined) {
    await undoSend(deps, rows, fileRows);
    throw new SurfaceError("NOT_FOUND", "conversation not found");
  }
  for (const u of rows) await store.uploads.markUsed(u.id, messageId);
  return { messageId };
}
