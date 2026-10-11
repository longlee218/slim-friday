import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_SET_NAME } from "../skills-config";
import { log } from "./plugin-copy";
import { allowedSkills, SKILL_SETS_DIR } from "./skill-sets";

/** Overlay file of a skill: `<set>/overlays/<skill>/app-overlay.md` (app-owned, add-only; upstream files stay unedited). */
const OVERLAY_FILE = "app-overlay.md";

/** Leading `<!-- ... -->` lines (the `overlay of <path>@<sha256>` header and notes) are metadata, not prompt text. */
function stripHeader(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && /^<!--.*-->\s*$/.test(lines[i] as string)) i++;
  return lines.slice(i).join("\n").trim();
}

/**
 * Overlay text of the skills a run loads: for each set, each skill the set gives (`allowedSkills`, so a skill
 * deferred to P3.4 gets none) that has an overlay file with a body. A missing file is normal (no overlay);
 * an unreadable one is warned and skipped. Empty string = nothing to add.
 */
export function skillOverlays(sets: readonly string[], setsDir = SKILL_SETS_DIR): string {
  const parts: string[] = [];
  for (const set of sets) {
    for (const skill of allowedSkills(set, setsDir)) {
      if (!SKILL_SET_NAME.test(skill)) continue; // a skill dir name is a plain slug: never a path
      try {
        const body = stripHeader(
          readFileSync(join(setsDir, set, "overlays", skill, OVERLAY_FILE), "utf8"),
        );
        if (body) parts.push(`### ${set}:${skill}\n${body}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT")
          log.warn({ set, skill, err: String(err) }, "skill overlay unreadable: skipped");
      }
    }
  }
  if (!parts.length) return "";
  return `## Skill overlays\nThese notes are part of the app and win over the skill text where they conflict.\n\n${parts.join("\n\n")}`;
}
