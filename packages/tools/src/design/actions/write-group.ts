import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { atomicWrite, checkWorkspace, need, plainId, Refused, toYaml } from "../design-util";

/** `workspaces`, `instructions` and `avatar` of an existing group file; empty when absent or unreadable. */
function existingGroupExtras(file: string): {
  workspaces?: unknown;
  instructions?: unknown;
  avatar?: unknown;
} {
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
    return {
      workspaces: parsed?.workspaces,
      instructions: parsed?.instructions,
      avatar: parsed?.avatar,
    };
  } catch {
    return {};
  }
}

/**
 * Validate the input, render `groups/<id>.yaml` and check it with the app's parser; nothing is written. Members must
 * be bots that exist (not a reserved one).
 */
export function buildGroupFile(ctx: DesignContext, a: DesignArgs): { file: string; text: string } {
  const id = plainId(a.id);
  const members = a.members ?? [];
  const exist = new Set(ctx.botSummaries().map((b) => b.id));
  for (const m of members) {
    if (ctx.reservedBotIds.includes(m))
      throw new Refused(`bot "${m}" cannot be in a group.`, "members");
    if (!exist.has(m)) throw new Refused(`member "${m}" is not a bot that exists.`, "members");
  }
  const entryBot = need(a.entryBot, "entryBot");
  if (!members.includes(entryBot))
    throw new Refused("entryBot must be one of the members.", "entryBot");
  for (const w of a.workspaces ?? []) checkWorkspace(ctx, w);
  const file = join(ctx.configDir, "groups", `${id}.yaml`);
  // On overwrite, a field not given keeps the old file's value; the final text is still checked.
  const old = a.overwrite ? existingGroupExtras(file) : {};
  const workspaces = a.workspaces ?? old.workspaces;
  const instructions = a.instructions ?? old.instructions;
  // BotDesign never sets a group avatar (the web app does); an overwrite keeps it.
  const avatar = old.avatar;
  const text = toYaml({
    name: need(a.name, "name"),
    members,
    entryBot,
    ...(workspaces !== undefined && { workspaces }),
    ...(instructions !== undefined && { instructions }),
    ...(avatar !== undefined && { avatar }),
  });
  try {
    ctx.checkGroup(id, text);
  } catch (err) {
    throw new Refused(
      `the group file is not valid: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      err,
    );
  }
  if (existsSync(file) && !a.overwrite)
    throw new Refused(
      `group "${id}" already exists; ask the owner, then call again with overwrite: true.`,
      "id",
    );
  return { file, text };
}

/** `write_group`: build the group file (see `buildGroupFile`), then write it. */
export function writeGroup(ctx: DesignContext, a: DesignArgs): string {
  const id = plainId(a.id);
  const { file, text } = buildGroupFile(ctx, a);
  atomicWrite(file, text);
  return `Wrote group ${id}. Its channel appears in a few seconds.`;
}
