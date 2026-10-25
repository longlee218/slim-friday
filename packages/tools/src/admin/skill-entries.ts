import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { AdminError, type SkillEntry } from "@friday/core";
import { readSkillLock } from "../design/actions/install-from-staged";
import type { DesignContext } from "../design/design-context";
import { listSkills } from "../design/design-util";
import { listBotEntries } from "./bot-admin";

/** The text of a SKILL.md after its front matter. */
const bodyOf = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/** All files of a skill dir, relative. */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !lstatSync(join(d, e.name)).isSymbolicLink()) walk(join(d, e.name));
      else
        out.push(
          join(d, e.name)
            .slice(dir.length + 1)
            .split(sep)
            .join("/"),
        );
    }
  };
  walk(dir);
  return out.sort();
}

/** The lock entry of an installed skill, as written by `installFromStaged`. */
type LockEntry = { source?: string; path?: string; sha?: string; installedAt?: string };

/** Read-only views over the skills dirs: shipped and owner names, lock entries and listed entries. */
export function skillViews(ctx: DesignContext) {
  const shippedNames = () => new Set(listSkills(ctx.skillDirs.slice(1)).map((s) => s.name));
  const ownerNames = () => new Set(listSkills(ctx.skillDirs.slice(0, 1)).map((s) => s.name));
  const lockOf = (name: string) => readSkillLock(ctx.configDir)[name] as LockEntry | undefined;
  /** One skill as listed (the first dir that holds it wins, as for a bot). */
  const entryOf = (name: string): SkillEntry => {
    const s = listSkills(ctx.skillDirs).find((x) => x.name === name);
    if (!s) throw new AdminError("NOT_FOUND", `skill "${name}" does not exist`, "name");
    const shipped = !ownerNames().has(name);
    const lock = shipped ? undefined : lockOf(name);
    return {
      name,
      description: s.description,
      shipped,
      ...(lock?.source !== undefined && { source: lock.source }),
      ...(lock?.path !== undefined && { path: lock.path }),
      ...(lock?.sha !== undefined && { sha: lock.sha }),
      ...(lock?.installedAt !== undefined && { installedAt: lock.installedAt }),
      files: filesOf(s.dir),
      body: bodyOf(readFileSync(join(s.dir, "SKILL.md"), "utf8")),
      usedBy: listBotEntries(ctx)
        .filter((b) => b.skills.includes(name))
        .map((b) => b.id),
    };
  };
  return { shippedNames, ownerNames, lockOf, entryOf };
}
