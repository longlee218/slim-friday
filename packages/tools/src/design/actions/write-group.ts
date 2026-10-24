import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { atomicWrite, checkWorkspace, need, plainId, Refused, toYaml } from "../design-util";

/** `workspaces` and `instructions` of an existing group file; empty when absent or unreadable. */
function existingGroupExtras(file: string): { workspaces?: unknown; instructions?: unknown } {
  try {
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
    return { workspaces: parsed?.workspaces, instructions: parsed?.instructions };
  } catch {
    return {};
  }
}

/** `write_group`: members must be bots that exist (not a reserved one); checked with the app's parser. */
export function writeGroup(ctx: DesignContext, a: DesignArgs): string {
  const id = plainId(a.id);
  const members = a.members ?? [];
  const exist = new Set(ctx.botSummaries().map((b) => b.id));
  for (const m of members) {
    if (ctx.reservedBotIds.includes(m)) throw new Refused(`bot "${m}" cannot be in a group.`);
    if (!exist.has(m)) throw new Refused(`member "${m}" is not a bot that exists.`);
  }
  const entryBot = need(a.entryBot, "entryBot");
  if (!members.includes(entryBot)) throw new Refused("entryBot must be one of the members.");
  for (const w of a.workspaces ?? []) checkWorkspace(ctx, w);
  const file = join(ctx.configDir, "groups", `${id}.yaml`);
  // On overwrite, a field not given keeps the old file's value; the final text is still checked.
  const old = a.overwrite ? existingGroupExtras(file) : {};
  const workspaces = a.workspaces ?? old.workspaces;
  const instructions = a.instructions ?? old.instructions;
  const text = toYaml({
    name: need(a.name, "name"),
    members,
    entryBot,
    ...(workspaces !== undefined && { workspaces }),
    ...(instructions !== undefined && { instructions }),
  });
  try {
    ctx.checkGroup(id, text);
  } catch (err) {
    throw new Refused(
      `the group file is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (existsSync(file) && !a.overwrite)
    throw new Refused(
      `group "${id}" already exists; ask the owner, then call again with overwrite: true.`,
    );
  atomicWrite(file, text);
  return `Wrote group ${id}. Its channel appears in a few seconds.`;
}
