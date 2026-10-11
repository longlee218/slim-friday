import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Format of `skills-lock.json` (the `skills` CLI): one entry per skill dir, pinned by a folder hash. */
export interface SkillsLock {
  version: number;
  skills: Record<
    string,
    { source: string; sourceType: string; skillPath: string; computedHash: string }
  >;
}

/** Dirs the folder hash skips (VCS and dependency trees). */
const HASH_SKIP = new Set(["node_modules", ".git"]);

/** Every regular file under `dir` as `{ rel (posix), content }`. */
function collect(root: string, dir: string, out: { rel: string; content: Buffer }[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (HASH_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(root, p, out);
    else if (e.isFile())
      out.push({
        rel: p
          .slice(root.length + 1)
          .split("\\")
          .join("/"),
        content: readFileSync(p),
      });
  }
}

/**
 * The folder hash `skills-lock.json` records (computedHash): sha256 over every file of the skill dir, sorted by
 * relative path, feeding each path then its bytes. Checked against the lock for every pinned skill.
 */
export function skillDirHash(dir: string): string {
  const files: { rel: string; content: Buffer }[] = [];
  collect(dir, dir, files);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.rel);
    h.update(f.content);
  }
  return h.digest("hex");
}

/** The repo-root lock, parsed. */
export const readSkillsLock = (): SkillsLock =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "skills-lock.json"), "utf8"));
