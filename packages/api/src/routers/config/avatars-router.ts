import { randomUUID } from "node:crypto";
import { MAX_AVATAR_BYTES } from "@friday/contracts";
import type { AvatarTarget, UploadRow } from "@friday/core";
import { ORPCError } from "@orpc/server";
import { logApiEvent } from "../../api-log";
import type { ApiDeps } from "../../app";
import { isOwnAvatarRow, uploadIdOf } from "../../avatar-url";
import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { checkAvatarUpload, copyAvatarUpload, discardCopy } from "./avatar-upload-check";

/** Seconds the browser has to PUT the image. */
const AVATAR_PUT_SECONDS = 600;

/** What the owner picked: a preset, an upload or (groups only) no avatar. */
export interface AvatarChoice {
  preset?: string;
  uploadId?: string;
  none?: boolean;
}

/** Delete an upload's object, then its row; a failure is logged, never thrown. */
async function removeUpload(deps: ApiDeps, row: UploadRow) {
  try {
    await deps.files.delete(row.key);
    await deps.store.uploads.delete(row.id);
  } catch (err) {
    logApiEvent(deps.log, "avatar.delete_failed", { uploadId: row.id, error: String(err) }, "warn");
  }
}

/** Delete the object and row of a replaced upload; a failure is logged, never thrown. */
async function dropOld(deps: ApiDeps, t: AvatarTarget, previous: string | undefined) {
  const old = uploadIdOf(previous);
  if (old === undefined) return;
  try {
    const row = await deps.store.uploads.get(old);
    // The config file names the old upload and a bot can write that: act only on this target's own avatar rows.
    if (!isOwnAvatarRow(row, t)) {
      logApiEvent(deps.log, "avatar.old_skipped", { uploadId: old }, "warn");
      return;
    }
    await removeUpload(deps, row);
  } catch (err) {
    logApiEvent(deps.log, "avatar.delete_failed", { uploadId: old, error: String(err) }, "warn");
  }
}

/**
 * Set a bot or group avatar from exactly one choice. An upload is checked, copied to a
 * server-owned key, the copy is written to the config file, and only then are the uploaded
 * object and the replaced avatar deleted.
 */
export async function applyAvatar(deps: ApiDeps, t: AvatarTarget, c: AvatarChoice): Promise<void> {
  const choices = [c.preset, c.uploadId, c.none].filter((x) => x !== undefined);
  if (choices.length !== 1) {
    throw new ORPCError("BAD_REQUEST", { message: "exactly one of preset, uploadId, none" });
  }
  const { config } = deps.settings;
  if (c.preset !== undefined && !config.presets().includes(c.preset)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "unknown avatar preset",
      data: { field: "preset" },
    });
  }
  // An upload is copied to a server-owned key; only the copy becomes the avatar.
  let copy: UploadRow | undefined;
  let original: UploadRow | undefined;
  if (c.uploadId !== undefined) {
    original = await checkAvatarUpload(deps, t, c.uploadId);
    copy = await copyAvatarUpload(deps, t, original);
  }
  const value = copy ? `upload:${copy.id}` : (c.preset ?? null);
  let previous: string | undefined;
  try {
    ({ previous } = await adminCall(() => config.setAvatar(t, value)));
  } catch (err) {
    if (copy) await discardCopy(deps, copy);
    throw err;
  }
  // The client's PUT URL stays valid for a while; its object is no longer used, so remove it.
  if (original) await removeUpload(deps, original);
  await dropOld(deps, t, previous);
}

/** Avatar presets and upload tickets. */
export const avatarsRouter = {
  list: authed.config.avatars.list.handler(({ context }) =>
    context.deps.settings.config.presets().map((name) => ({ name, url: `/avatars/${name}.webp` })),
  ),
  create: authed.config.avatars.create.handler(async ({ input, context }) => {
    const { deps } = context;
    if (input.size > MAX_AVATAR_BYTES) {
      throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "avatar too large" });
    }
    const { config } = deps.settings;
    const known = (input.kind === "bot" ? config.listBots() : config.listGroups()).some(
      (e) => e.id === input.id,
    );
    if (!known) throw new ORPCError("NOT_FOUND", { message: `no ${input.kind} ${input.id}` });
    const uploadId = randomUUID();
    const ext = input.type === "image/webp" ? "webp" : "jpg";
    const key = `avatars/${input.kind}s/${input.id}/${uploadId}.${ext}`;
    await deps.store.uploads.insert({
      id: uploadId,
      key,
      conversationId: null,
      purpose: "avatar",
      name: `${uploadId}.${ext}`,
      mimeType: input.type,
      size: input.size,
      state: "pending",
      at: deps.now(),
    });
    return { uploadId, putUrl: deps.files.presignPut(key, AVATAR_PUT_SECONDS, input.type) };
  }),
};
