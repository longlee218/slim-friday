import type { FileStore } from "@friday/core";
import type { ApiDeps } from "./app";
import { encodeKey } from "./encode-key";

const HOUR_MS = 3_600_000;

/** Matches an uploaded avatar value `upload:<uploadId>` (a uuid); anything else is a preset name. */
const UPLOAD_AVATAR = /^upload:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The upload id inside an `upload:<id>` avatar value; undefined for a preset or no avatar. */
export function uploadIdOf(avatar: string | undefined): string | undefined {
  return avatar === undefined ? undefined : UPLOAD_AVATAR.exec(avatar)?.[1];
}

/**
 * Builds the avatar URL function. A preset is the web bundle's `/avatars/<name>.webp`. An upload
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
    if (!avatar.startsWith("upload:")) return `/avatars/${avatar}.webp`;
    if (key === undefined) return undefined;
    if (cdnUrl) return `${cdnUrl}/${encodeKey(key)}`;
    const t = now();
    const hit = cache.get(key);
    if (hit && t < hit.hourEnd) return hit.url;
    const hourEnd = (Math.floor(t / HOUR_MS) + 1) * HOUR_MS;
    // Valid until one hour after the hour ends.
    const url = files.presignGet(key, Math.ceil((hourEnd + HOUR_MS - t) / 1000));
    cache.set(key, { hourEnd, url });
    return url;
  };
}

/** One URL function per app deps, so the hourly cache is shared by every router. */
const perDeps = new WeakMap<object, ReturnType<typeof createAvatarUrls>>();

/** The avatar URL of a bot or group avatar value, looking up the upload's key when needed. */
export async function avatarUrlOf(
  deps: Pick<ApiDeps, "files" | "store" | "now" | "cdnUrl">,
  avatar: string | undefined,
): Promise<string | undefined> {
  let urls = perDeps.get(deps);
  if (!urls) {
    urls = createAvatarUrls(deps.files, deps.now, deps.cdnUrl);
    perDeps.set(deps, urls);
  }
  const id = uploadIdOf(avatar);
  const key = id === undefined ? undefined : (await deps.store.uploads.get(id))?.key;
  return urls(avatar, key);
}
