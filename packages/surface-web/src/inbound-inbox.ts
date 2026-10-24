import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { SurfaceError } from "./surface-error";

/**
 * A new private directory for the files of one send: `<inbox>/<conversation>/<epoch>-<random>` (unique per send,
 * so two sends in the same millisecond never share one). Created only when `create` is true (there are files).
 */
export async function openInboxDir(
  inboxDir: string,
  conversationId: string,
  now: number,
  create: boolean,
): Promise<string> {
  const dir = join(inboxDir, conversationId, `${now}-${randomUUID().slice(0, 8)}`);
  // Defense in depth: the directory must stay inside the inbox.
  if (!resolve(dir).startsWith(`${resolve(inboxDir)}${sep}`)) {
    throw new SurfaceError("BAD_REQUEST", "bad conversation id");
  }
  if (create) {
    // Create the directories private; mkdir's mode is masked by umask, so chmod after.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dirname(dir), 0o700);
    await chmod(dir, 0o700);
  }
  return dir;
}

/** Write file number `idx` (0-based) of a send as `<idx+1>-<name>`, private; returns its name and path. */
export async function writeInboxFile(
  dir: string,
  idx: number,
  safe: string,
  bytes: Uint8Array,
): Promise<{ name: string; path: string }> {
  const name = `${idx + 1}-${safe}`;
  const path = join(dir, name);
  // `wx`: never overwrite or follow an existing file.
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { name, path };
}
