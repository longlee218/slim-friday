import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SKILL_SET_NAME } from "../skills-config";
import { type FileFilter, log, type PluginCaps } from "./plugin-copy";

/** Vendored skill sets live here: `vendor/skill-sets/<name>/{skills,overlays,set.json,VENDOR.md}`. */
export const SKILL_SETS_DIR = join(import.meta.dir, "../../../vendor/skill-sets");

/** Caps of one set plugin (owner decision: 120 entries / 1 MB); the same numbers apply per skill. */
const SET_CAP = { files: 120, bytes: 1024 * 1024 };
export const SET_CAPS: PluginCaps = { skill: SET_CAP, total: SET_CAP };

/**
 * The only non-.md files a set plugin may hold: the 3 vendored SDD scripts (Rev 6), pinned by sha256 (equal to
 * the VENDOR.md rows, test-checked). Key = path under the set's `skills/`.
 */
export const PINNED_SCRIPTS: Record<string, string> = {
  "subagent-driven-development/scripts/sdd-workspace":
    "75ca46c756ba4209ca36e0d3d65567257ceb33bc7a6775b9dad946707cb3bd7b",
  "subagent-driven-development/scripts/task-brief":
    "cc563538e09abf719b34ddf4b2fa7a65cf3b301729039dbfa923cb060f729146",
  "subagent-driven-development/scripts/review-package":
    "f9275175b2276b1d5fdb1bae0bedaadd2a950659b7c6f311ea37ff85e1861b1f",
};

/**
 * `set.json`: `{ name, skills: string[] }` = the skills the set gives its role (one list for every stage of it).
 * Tolerated legacy shape: `skills` as a record of `{ lean?, full?: stages[] }`; the list is then the skills whose
 * `full` stages include `plan` or `exec` (qa and `lean` are ignored).
 */
const setSchema = z.object({
  name: z.string().regex(SKILL_SET_NAME),
  skills: z.union([
    z.array(z.string()),
    z.record(z.string(), z.object({ full: z.array(z.string()).optional() })),
  ]),
});

/**
 * Skills that need subagents and guard rules P3.4 builds (the Agent tool is not wired for them yet: loading them
 * would steer the exec model into flows the guard denies). Never loaded. REMOVE in P3.4.
 */
export const SKILLS_DEFERRED_TO_P34: readonly string[] = [
  "subagent-driven-development",
  "requesting-code-review",
  "receiving-code-review",
];

/** Skill dir names of set `set` (empty for an unknown/invalid set), minus the ones deferred to P3.4. */
export function allowedSkills(set: string, setsDir = SKILL_SETS_DIR): string[] {
  if (!SKILL_SET_NAME.test(set)) return [];
  try {
    const parsed = setSchema.parse(
      JSON.parse(readFileSync(join(setsDir, set, "set.json"), "utf8")),
    );
    if (parsed.name !== set) throw new Error(`set.json name "${parsed.name}" differs from its dir`);
    const list = Array.isArray(parsed.skills)
      ? parsed.skills
      : Object.entries(parsed.skills)
          .filter(([, v]) => v.full?.some((st) => st === "plan" || st === "exec"))
          .map(([skill]) => skill);
    return list.filter((skill) => !SKILLS_DEFERRED_TO_P34.includes(skill));
  } catch (err) {
    log.warn({ set, err: String(err) }, "skill set not loaded");
    return [];
  }
}

/** Copy filter of a set: `.md` files and the pinned scripts (a script whose sha256 differs is refused, warned). */
export const setFileFilter: FileFilter = (rel, abs) => {
  if (rel.endsWith(".md")) return true;
  const pinned = PINNED_SCRIPTS[rel];
  if (!pinned) return false;
  const ok = createHash("sha256").update(readFileSync(abs)).digest("hex") === pinned;
  if (!ok) log.warn({ file: rel }, "vendored script sha256 mismatch: not copied");
  return ok;
};
