import type { AvatarTarget, FileStore, UploadRow } from "@friday/core";
import type { ApiDeps } from "./app";
import { encodeKey } from "./encode-key";
import { SHIPPED_PRESETS } from "./shipped-avatars";

const HOUR_MS = 3_600_000;

/** Matches an uploaded avatar value `upload:<uploadId>` (a uuid); anything else is a preset name. */
const UPLOAD_AVATAR = /^upload:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The upload id inside an `upload:<id>` avatar value; undefined for a preset or no avatar. */
export function uploadIdOf(avatar: string | undefined): string | undefined {
  return avatar === undefined ? undefined : UPLOAD_AVATAR.exec(avatar)?.[1];
}

/**
 * Builds the avatar URL function. A shipped preset is the web bundle's `/avatars/<name>.webp`. An upload
 * (needs its object `key`) is `${cdnUrl}/<key>` when the owner's CDN is set; otherwise a presigned
 * GET cached per key until the hour ends, so the URL stays the same all hour (the browser caches
 * the image) and the link is still valid for one more hour after that.
 */
export function createAvatarUrls(
  files: FileStore,
  now: () => number,
  cdnUrl?: string,
): (avatar: string | undefined, key?: string) => string | undefined {
  const cache = new Map<string, { hourEnd: number; url: string }>();
  return (avatar, key) => {
    if (avatar === undefined) return undefined;
    // An owner-made preset has no image in the web bundle: no URL, the UI shows initials.
    if (!avatar.startsWith("upload:"))
      return SHIPPED_PRESETS.includes(avatar) ? `/avatars/${avatar}.webp` : undefined;
    if (key === undefined) return undefined;
    if (cdnUrl) return `${cdnUrl}/${encodeKey(key)}`;
    const t = now();
    const hit = cache.get(key);
    if (hit && t < hit.hourEnd) return hit.url;
    // Drop entries whose hour has passed, so the cache cannot grow without bound.
    for (const [k, e] of cache) if (e.hourEnd <= t) cache.delete(k);
    const hourEnd = (Math.floor(t / HOUR_MS) + 1) * HOUR_MS;
    // Valid until one hour after the hour ends.
    const url = files.presignGet(key, Math.ceil((hourEnd + HOUR_MS - t) / 1000));
    cache.set(key, { hourEnd, url });
    return url;
  };
}

/**
 * True for an avatar upload row that lives under the target's own key prefix. A config file can
 * name any `upload:<uuid>` (a bot can write one through BotDesign), so nothing acts on a row
 * (URL, delete) before this holds.
 */
export function isOwnAvatarRow(row: UploadRow | undefined, t: AvatarTarget): row is UploadRow {
  return row?.purpose === "avatar" && row.key.startsWith(`avatars/${t.kind}s/${t.id}/`);
}

/** One URL function per app deps, so the hourly cache is shared by every router. */
const perDeps = new WeakMap<object, ReturnType<typeof createAvatarUrls>>();

/** The avatar URL of a bot or group avatar value, looking up the upload's key when needed. */
export async function avatarUrlOf(
  deps: Pick<ApiDeps, "files" | "store" | "now" | "cdnUrl">,
  avatar: string | undefined,
  target: AvatarTarget,
): Promise<string | undefined> {
  let urls = perDeps.get(deps);
  if (!urls) {
    urls = createAvatarUrls(deps.files, deps.now, deps.cdnUrl);
    perDeps.set(deps, urls);
  }
  const id = uploadIdOf(avatar);
  // A malformed `upload:` value is not a preset either: no URL.
  if (id === undefined) return avatar?.startsWith("upload:") ? undefined : urls(avatar);
  const row = await deps.store.uploads.get(id);
  // Only a server-made copy (`used`): a pending client upload keeps its client-chosen type and a live PUT URL.
  return isOwnAvatarRow(row, target) && row.state === "used" ? urls(avatar, row.key) : undefined;
}
