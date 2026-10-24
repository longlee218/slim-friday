import { randomUUID } from "node:crypto";
import { MAX_AVATAR_BYTES } from "@friday/contracts";
import type { AvatarTarget } from "@friday/core";
import { ORPCError } from "@orpc/server";
import { logApiEvent } from "../../api-log";
import type { ApiDeps } from "../../app";
import { uploadIdOf } from "../../avatar-url";
import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { checkAvatarUpload } from "./avatar-upload-check";

/** Seconds the browser has to PUT the image. */
const AVATAR_PUT_SECONDS = 600;

/** What the owner picked: a preset, an upload or (groups only) no avatar. */
export interface AvatarChoice {
  preset?: string;
  uploadId?: string;
  none?: boolean;
}

/** Delete the object and row of a replaced upload; a failure is logged, never thrown. */
async function dropOld(deps: ApiDeps, previous: string | undefined, keep: string | undefined) {
  const old = uploadIdOf(previous);
  if (old === undefined || old === keep) return;
  try {
    const row = await deps.store.uploads.get(old);
    if (row) await deps.files.delete(row.key);
    await deps.store.uploads.delete(old);
  } catch (err) {
    logApiEvent(deps.log, "avatar.delete_failed", { uploadId: old, error: String(err) }, "warn");
  }
}

/**
 * Set a bot or group avatar from exactly one choice. An upload is checked first, written to the
 * config file, marked used, and only then is the replaced upload deleted.
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
  if (c.uploadId !== undefined) await checkAvatarUpload(deps, t, c.uploadId);
  const value = c.uploadId !== undefined ? `upload:${c.uploadId}` : (c.preset ?? null);
  const { previous } = await adminCall(() => config.setAvatar(t, value));
  if (c.uploadId !== undefined) await deps.store.uploads.markUsed(c.uploadId, null);
  await dropOld(deps, previous, c.uploadId);
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
