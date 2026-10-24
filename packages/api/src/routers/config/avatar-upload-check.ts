import { randomUUID } from "node:crypto";
import { MAX_AVATAR_BYTES } from "@friday/contracts";
import type { AvatarTarget, UploadRow } from "@friday/core";
import { ORPCError } from "@orpc/server";
import type { ApiDeps } from "../../app";

/** First bytes of a WebP file are `RIFF????WEBP`; of a JPEG `FF D8 FF`. */
const isWebp = (b: Uint8Array) =>
  b.length >= 12 &&
  [0x52, 0x49, 0x46, 0x46].every((v, i) => b[i] === v) &&
  [0x57, 0x45, 0x42, 0x50].every((v, i) => b[8 + i] === v);
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Server-chosen type and extension of an image, from its bytes. */
const kindOf = (b: Uint8Array) =>
  isWebp(b) ? { type: "image/webp", ext: "webp" } : { type: "image/jpeg", ext: "jpg" };

/** Remove a refused object and its row (best effort: the sweeper also drops old pending rows). */
async function discard(deps: Pick<ApiDeps, "files" | "store">, row: UploadRow): Promise<void> {
  await deps.files.delete(row.key);
  await deps.store.uploads.delete(row.id);
}

/**
 * Checks an avatar upload before it may be set on `target`: it must be a pending avatar upload
 * made for that very bot or group, the stored object must exist, stay within 2 MB and start with
 * the magic bytes of the type its key promises (`.webp` or `.jpg`). What the client declared is
 * never trusted. A too-large or wrong-type object is deleted. Returns the upload row.
 */
export async function checkAvatarUpload(
  deps: Pick<ApiDeps, "files" | "store">,
  target: AvatarTarget,
  uploadId: string,
): Promise<UploadRow> {
  const row = await deps.store.uploads.get(uploadId);
  if (!row) throw new ORPCError("NOT_FOUND", { message: "upload not found" });
  const prefix = `avatars/${target.kind}s/${target.id}/`;
  if (row.purpose !== "avatar" || row.state === "used" || !row.key.startsWith(prefix)) {
    throw new ORPCError("BAD_REQUEST", { message: "upload belongs to something else" });
  }
  const stat = await deps.files.stat(row.key);
  if (!stat) throw new ORPCError("BAD_REQUEST", { message: "nothing was uploaded" });
  if (stat.size > MAX_AVATAR_BYTES) {
    await discard(deps, row);
    throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "avatar too large" });
  }
  const head = await deps.files.readHead(row.key, 12);
  const ok = row.key.endsWith(".webp") ? isWebp(head) : row.key.endsWith(".jpg") && isJpeg(head);
  if (!ok) {
    await discard(deps, row);
    throw new ORPCError("BAD_REQUEST", { message: "avatar is not a WebP or JPEG image" });
  }
  return row;
}

/**
 * Copies a checked upload to a new server-owned key with a server-set content type, and returns
 * the new `used` avatar row. The browser's presigned PUT can set any content type and stays
 * valid after the check, so the uploaded object itself is never served: a later PUT to its key
 * touches nothing in use. The bytes are checked again as read (the object may have changed
 * since the check). The caller deletes the original once the config write succeeded.
 */
export async function copyAvatarUpload(
  deps: Pick<ApiDeps, "files" | "store">,
  target: AvatarTarget,
  row: UploadRow,
): Promise<UploadRow> {
  const data = await deps.files.read(row.key);
  const ok = isWebp(data) || isJpeg(data);
  if (data.length > MAX_AVATAR_BYTES || !ok) {
    await discard(deps, row);
    throw new ORPCError("BAD_REQUEST", { message: "avatar is not a WebP or JPEG image" });
  }
  const { type, ext } = kindOf(data);
  const id = randomUUID();
  const key = `avatars/${target.kind}s/${target.id}/${id}.${ext}`;
  await deps.files.put(key, data, type);
  const copy: UploadRow = {
    id,
    key,
    conversationId: null,
    purpose: "avatar",
    name: `${id}.${ext}`,
    mimeType: type,
    size: data.length,
    state: "used",
    at: row.at,
  };
  await deps.store.uploads.insert(copy);
  return copy;
}

/** Remove a copy made by `copyAvatarUpload` (the config write failed). */
export async function discardCopy(deps: Pick<ApiDeps, "files" | "store">, copy: UploadRow) {
  await discard(deps, copy);
}
