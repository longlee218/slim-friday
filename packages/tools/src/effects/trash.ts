import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { trashRoot } from "./trash-store";

/** Empty the whole trash now (`/purge`). Returns how many entries (`<bot>/<stamp>` dirs) were removed. */
export function purgeTrash(home: string): number {
  const root = trashRoot(home);
  let owners: string[];
  try {
    owners = readdirSync(root);
  } catch {
    return 0; // no trash yet
  }
  let n = 0;
  for (const owner of owners) {
    const dir = join(root, owner);
    try {
      n += readdirSync(dir).length;
    } catch {
      // A stray file or a link: removed below, not counted.
    }
    // rmSync never follows a symlink: a planted link is removed, not its target.
    rmSync(dir, { recursive: true, force: true });
  }
  return n;
}
