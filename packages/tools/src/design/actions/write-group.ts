import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { atomicWrite, need, plainId, Refused, toYaml } from "../design-util";

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
  const text = toYaml({
    name: need(a.name, "name"),
    members,
    entryBot,
  });
  try {
    ctx.checkGroup(id, text);
  } catch (err) {
    throw new Refused(
      `the group file is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const file = join(ctx.configDir, "groups", `${id}.yaml`);
  if (existsSync(file) && !a.overwrite)
    throw new Refused(
      `group "${id}" already exists; ask the owner, then call again with overwrite: true.`,
    );
  atomicWrite(file, text);
  return `Wrote group ${id}. Its channel appears in a few seconds.`;
}
