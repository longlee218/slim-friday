import { existsSync } from "node:fs";
import { join } from "node:path";

/** Avatars shipped with the repo (`public/avatars/<name>.png`). */
export const AVATARS_DIR = join(import.meta.dir, "..", "..", "..", "public", "avatars");

/**
 * The PNG file of an avatar name: the owner's `<AGENT_HOME>/config/avatars/<name>.png` first, then the shipped one.
 * Undefined when no name is given or no file exists (the bot then speaks with the default avatar).
 */
export function resolveAvatar(name: string | undefined, dirs: string[]): string | undefined {
  if (!name) return undefined;
  return dirs.map((d) => join(d, `${name}.png`)).find((f) => existsSync(f));
}
