import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { AdminError, type SkillAdmin, type SkillEntry, type SkillLookup } from "@friday/core";
import { installFromStaged } from "../design/actions/install-from-staged";
import { skillName } from "../design/actions/write-skill";
import type { DesignContext } from "../design/design-context";
import { listSkills } from "../design/design-util";
import { cloneSkillSource } from "../skills/clone-skill-source";
import { parseSkillSource } from "../skills/skill-source-url";
import { toAdminError } from "./admin-errors";
import { guarded } from "./bot-admin";
import { skillViews } from "./skill-entries";
import {
  findSkills,
  LOOKUP_TTL_MS,
  type LookupState,
  removeDir,
  sweepLookups,
} from "./skill-lookups";
import { lsRemoteHead } from "./skill-ls-remote";
import { removeSkill, setSkillUsers } from "./skill-usage";

/** What `createSkillAdmin` needs besides the design context. */
export interface SkillAdminDeps {
  ctx: DesignContext;
  /** `<AGENT_HOME>/data/skill-lookups`: clones wait here until the owner confirms (outside the watched config dir). */
  lookupDir: string;
  /** `PATH` handed to git. */
  pathEnv: string;
  now: () => number;
  /** The clone call (tests pass a fake). */
  clone?: typeof cloneSkillSource;
  /** `git ls-remote <url> HEAD` output (tests pass a fake). */
  lsRemote?: (url: string) => Promise<string>;
}

/**
 * The skills admin: `lookup` clones into `lookupDir` and installs nothing; `install` and `update` take a lookup id
 * the owner confirmed (used once, valid 15 minutes). Writes go to `<config>/skills/` and the bot files only.
 */
export function createSkillAdmin(deps: SkillAdminDeps): SkillAdmin {
  const { ctx, lookupDir, now } = deps;
  const clone = deps.clone ?? cloneSkillSource;
  const lookups = new Map<string, LookupState>();

  const lsRemote = deps.lsRemote ?? ((url: string) => lsRemoteHead(url, lookupDir, deps.pathEnv));

  const { shippedNames, ownerNames, lockOf, entryOf } = skillViews(ctx);

  /** A live lookup that found `name`, or the refusal; an expired lookup is dropped. */
  const confirmed = (lookupId: string, name: string) => {
    const l = lookups.get(lookupId);
    if (l && l.expiresAt <= now()) {
      removeDir(l.dir);
      lookups.delete(lookupId);
    } else if (l) {
      const found = l.skills.find((s) => s.name === name);
      if (!found)
        throw new AdminError("BAD_REQUEST", `the lookup did not find skill "${name}"`, "name");
      return { l, found };
    }
    throw new AdminError("BAD_REQUEST", "not confirmed: look the source up again");
  };

  /** Install the confirmed skill from the lookup's dir, then consume the lookup. */
  const apply = (lookupId: string, name: string, overwrite: boolean): SkillEntry => {
    const { l, found } = confirmed(lookupId, name);
    guarded(() => {
      skillName(name);
      installFromStaged(ctx, {
        stagedDir: join(l.dir, found.rel),
        name,
        source: l.source,
        ...(l.path !== undefined && { path: l.path }),
        sha: l.sha,
        overwrite,
      });
    });
    removeDir(l.dir);
    lookups.delete(lookupId);
    return entryOf(name);
  };

  return {
    list: () => listSkills(ctx.skillDirs).map((s) => entryOf(s.name)),

    async lookup(source, path): Promise<SkillLookup> {
      mkdirSync(lookupDir, { recursive: true });
      sweepLookups(lookupDir, lookups, now());
      let cloned: Awaited<ReturnType<typeof cloneSkillSource>> | undefined;
      try {
        parseSkillSource(source, path);
        cloned = await clone(source, { path, tmpRoot: lookupDir, pathEnv: deps.pathEnv });
        const skills = findSkills(cloned.dir, path);
        const lookupId = crypto.randomUUID();
        const dir = join(lookupDir, lookupId);
        // Same disk as the clone's temp dir (both under lookupDir), so this is a rename.
        renameSync(cloned.dir, dir);
        cloned.cleanup();
        const expiresAt = now() + LOOKUP_TTL_MS;
        lookups.set(lookupId, {
          dir,
          source,
          ...(path !== undefined && { path }),
          sha: cloned.sha,
          skills,
          expiresAt,
        });
        return {
          lookupId,
          source,
          ...(path !== undefined && { path }),
          sha: cloned.sha,
          expiresAt,
          skills: skills.map(({ name, description, files, scripts }) => ({
            name,
            description,
            files,
            scripts,
          })),
        };
      } catch (err) {
        cloned?.cleanup();
        throw toAdminError(err);
      }
    },

    install(lookupId, name) {
      confirmed(lookupId, name);
      if (listSkills(ctx.skillDirs).some((s) => s.name.toLowerCase() === name.toLowerCase()))
        throw new AdminError("CONFLICT", `skill "${name}" already exists`, "name");
      return apply(lookupId, name, false);
    },

    async checkUpdate(name) {
      const lock = lockOf(name);
      if (!ownerNames().has(name) || !lock?.source)
        throw new AdminError(
          "BAD_REQUEST",
          `skill "${name}" was not installed from a source`,
          "name",
        );
      const out = await (async () => {
        try {
          return await lsRemote(parseSkillSource(lock.source as string).url);
        } catch (err) {
          throw toAdminError(err);
        }
      })();
      const latestSha = out.split("\n")[0]?.split(/\s+/)[0] ?? "";
      if (!latestSha) throw new AdminError("BAD_REQUEST", "the source returned no HEAD", "source");
      return {
        ...(lock.sha !== undefined && { sha: lock.sha }),
        latestSha,
        updateAvailable: lock.sha !== latestSha,
      };
    },

    update(lookupId, name) {
      const { l } = confirmed(lookupId, name);
      if (shippedNames().has(name))
        throw new AdminError("BAD_REQUEST", "shipped skills cannot be updated", "name");
      if (!ownerNames().has(name))
        throw new AdminError("NOT_FOUND", `skill "${name}" is not installed`, "name");
      if (lockOf(name)?.path !== l.path)
        throw new AdminError(
          "BAD_REQUEST",
          "the lookup path is not the path the skill was installed from",
          "path",
        );
      if (lockOf(name)?.source !== l.source)
        throw new AdminError(
          "BAD_REQUEST",
          "the lookup source is not the source the skill was installed from",
          "source",
        );
      return apply(lookupId, name, true);
    },

    remove: (name) => removeSkill(ctx, name),
    setUsedBy: (name, botIds) => setSkillUsers(ctx, name, botIds),
  };
}
