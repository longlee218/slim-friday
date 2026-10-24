import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { listSkills, need, Refused, replaceDir, SKILL_NAME_RE, skillFront } from "../design-util";

/** Most files and bytes of one written skill. */
export const SKILL_MAX_FILES = 40;
export const SKILL_MAX_BYTES = 256 * 1024;

/** A relative path made of plain segments only (no `..`, no leading dot, no empty part). */
const SAFE_REL = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The name of a skill: refuses anything that could become a path. */
export function skillName(value: string | undefined): string {
  const v = need(value, "id");
  if (!SKILL_NAME_RE.test(v))
    throw new Refused("a skill name is letters, digits, `.`, `_` and `-`.");
  return v;
}

/** Refuse a skill that already exists (owner or shipped) unless `overwrite` is set. */
export function refuseExisting(ctx: DesignContext, name: string, overwrite?: boolean): void {
  if (!overwrite && listSkills(ctx.skillDirs).some((s) => s.name === name))
    throw new Refused(
      `skill "${name}" already exists; ask the owner, then call again with overwrite: true.`,
    );
}

/** `write_skill`: write the given files as `<config>/skills/<name>/`. */
export function writeSkill(ctx: DesignContext, a: DesignArgs): string {
  const name = skillName(a.id);
  const files = a.files ?? [];
  if (files.length === 0 || files.length > SKILL_MAX_FILES)
    throw new Refused(`give 1 to ${SKILL_MAX_FILES} files.`);
  let bytes = 0;
  const out = new Map<string, string>();
  for (const f of files) {
    if (!SAFE_REL.test(f.path)) throw new Refused(`unsafe file path: ${f.path}`);
    bytes += Buffer.byteLength(f.content);
    out.set(f.path, f.content);
  }
  if (bytes > SKILL_MAX_BYTES) throw new Refused(`over ${SKILL_MAX_BYTES / 1024} KB in total.`);
  const main = out.get("SKILL.md");
  if (main === undefined) throw new Refused("SKILL.md is required.");
  const front = skillFront(main);
  if (front.name !== name) throw new Refused(`the SKILL.md name must be "${name}".`);
  if (!front.description || front.description.length < 20)
    throw new Refused("SKILL.md needs a description (at least 20 chars).");
  refuseExisting(ctx, name, a.overwrite);
  const target = join(ctx.configDir, "skills", name);
  if (existsSync(target) && !a.overwrite) throw new Refused(`skill "${name}" already exists.`);
  replaceDir(target, out);
  return `Wrote skill ${name} (${out.size} files).`;
}
