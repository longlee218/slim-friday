import { z } from "zod";

/** Prefix of an avatar value that names an uploaded image instead of a preset. */
const UPLOAD_PREFIX = "upload:";

/**
 * An avatar value: a preset name (the app maps it to `<name>.png` in its avatar dirs) or
 * `upload:<uuid>` (an image the owner uploaded; the id is part of its storage key).
 */
export const avatarSchema = z
  .string()
  .regex(/^(?:[A-Za-z][A-Za-z0-9_-]{0,31}|upload:[0-9a-f-]{36})$/);

/** The upload id of an `upload:<id>` avatar value; undefined for a preset name. */
export function isUploadAvatar(v: string): string | undefined {
  return v.startsWith(UPLOAD_PREFIX) ? v.slice(UPLOAD_PREFIX.length) : undefined;
}
