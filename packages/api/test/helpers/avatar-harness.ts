import { beforeEach } from "bun:test";
import { engineHarness } from "./engine-deps";

/** Smallest byte prefixes the avatar check accepts or refuses. */
export const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);
export const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0]);
export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** The harness of the current test: a fresh one with bots dev and tess, group team, two presets. */
export const ctx = {} as { h: ReturnType<typeof engineHarness> };
/** Call once at the top of a test file: every test then starts on a fresh harness. */
export function useAvatarHarness(): void {
  beforeEach(() => {
    const h = engineHarness();
    h.addBot("dev", "Dev");
    h.addBot("tess", "Tess");
    h.addGroup({ id: "team", name: "Team" });
    h.settings.config.presetNames = ["designer", "developer"];
    ctx.h = h;
  });
}

/** Ask for a ticket and put the object in the fake store, as the browser would. */
export async function upload(
  id: string,
  bytes: Uint8Array,
  type: "image/webp" | "image/jpeg" = "image/webp",
  kind: "bot" | "group" = "bot",
) {
  const { h } = ctx;
  // The declared size is small on purpose: the stored bytes are what gets checked.
  const { uploadId } = await h.client.config.avatars.create({ kind, id, size: 10, type });
  const row = await h.store.uploads.get(uploadId);
  await h.files.put(row?.key as string, bytes, type);
  return uploadId;
}

/** The object key of an upload row. */
export const keyOf = async (id: string) => (await ctx.h.store.uploads.get(id))?.key as string;
