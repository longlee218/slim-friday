import { rmSync } from "node:fs";
import { join } from "node:path";
import { AdminError, type SkillEntry } from "@friday/core";
import { readSkillLockForWrite, skillLockFile } from "../design/actions/install-from-staged";
import { skillName } from "../design/actions/write-skill";
import { editBotHeader } from "../design/bot-file-edit";
import type { DesignContext } from "../design/design-context";
import { atomicWrite, toYaml } from "../design/design-util";
import { guarded, listBotEntries } from "./bot-admin";
import { insideConfig } from "./config-paths";
import { skillViews } from "./skill-entries";

/** The skill names of a bot header without `name`. */
const without = (skills: unknown, name: string): unknown[] =>
  (Array.isArray(skills) ? skills : []).filter((s) => String(s) !== name);

/**
 * Remove an installed skill: delete its dir and lock entry, then take its name out of every owner bot file. Shipped skills are refused. Returns the bots that named it.
 */
export function removeSkill(ctx: DesignContext, name: string): { botIds: string[] } {
  return guarded(() => {
    skillName(name);
    const { shippedNames, ownerNames } = skillViews(ctx);
    if (shippedNames().has(name) && !ownerNames().has(name))
      throw new AdminError("BAD_REQUEST", "shipped skills cannot be removed", "name");
    if (!ownerNames().has(name))
      throw new AdminError("NOT_FOUND", `skill "${name}" does not exist`, "name");
    // A broken lock refuses before anything changes.
    const lock = readSkillLockForWrite(ctx.configDir);
    const botIds = listBotEntries(ctx)
      .filter((b) => !b.shipped && b.skills.includes(name))
      .map((b) => b.id);
    // The skill goes first: a failure while editing bots then leaves a skill no bot can load, not a half-edited state.
    rmSync(insideConfig(ctx.configDir, join(ctx.configDir, "skills", name)), {
      recursive: true,
      force: true,
    });
    if (name in lock) {
      delete lock[name];
      atomicWrite(insideConfig(ctx.configDir, skillLockFile(ctx.configDir)), toYaml(lock));
    }
    for (const id of botIds)
      editBotHeader(ctx, id, (h) => {
        h.skills = without(h.skills, name);
      });
    return { botIds };
  });
}

/**
 * Make exactly `botIds` the users of a skill. Every id is checked before any file changes; only bots whose
 * membership changes are edited, and a shipped bot in that set refuses the call.
 */
export function setSkillUsers(ctx: DesignContext, name: string, botIds: string[]): SkillEntry {
  return guarded(() => {
    const { entryOf } = skillViews(ctx);
    entryOf(name);
    const want = new Set(botIds);
    const bots = listBotEntries(ctx);
    for (const id of want)
      if (!bots.some((b) => b.id === id))
        throw new AdminError("NOT_FOUND", `bot "${id}" does not exist`, "botIds");
    const changing = bots.filter((b) => b.skills.includes(name) !== want.has(b.id));
    if (changing.some((b) => b.shipped))
      throw new AdminError("BAD_REQUEST", "shipped bots are read only", "botIds");
    for (const b of changing)
      editBotHeader(ctx, b.id, (h) => {
        const rest = without(h.skills, name);
        h.skills = want.has(b.id) ? [...rest, name] : rest;
      });
    return entryOf(name);
  });
}
