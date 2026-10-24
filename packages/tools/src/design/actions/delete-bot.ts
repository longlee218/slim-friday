import { existsSync } from "node:fs";
import { join } from "node:path";
import { moveToTrash } from "../../effects/trash-store";
import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { plainId, Refused } from "../design-util";

/**
 * `delete_bot`: move an owner bot's file and its memory dir to the trash (kept 7 days, `/purge` empties it). Refused for
 * a reserved bot, a bot that is only shipped or does not exist, and a bot still in a group (rewrite the group first).
 * Its running session closes when the config reloads; its sessions and wakes rows are left to the sweepers.
 */
export function deleteBot(ctx: DesignContext, a: DesignArgs): string {
  const id = plainId(a.id);
  if (ctx.reservedBotIds.includes(id)) throw new Refused(`bot "${id}" is reserved.`);
  const file = join(ctx.configDir, "bots", `${id}.md`);
  if (!existsSync(file)) throw new Refused(`bot "${id}" is not one of the owner's bots.`);
  const groups = ctx.groupSummaries().filter((g) => g.members.includes(id));
  if (groups.length)
    throw new Refused(
      `bot "${id}" is in group ${groups.map((g) => g.id).join(", ")}; remove it with write_group first.`,
    );
  const memoryDir = ctx.memory.dirOf({ kind: "bot", botId: id });
  const paths = existsSync(memoryDir) ? [file, memoryDir] : [file];
  const move = moveToTrash(ctx.agentHome, ctx.botId, paths, Date.now());
  if (move.error)
    throw new Error(
      `trash move stopped (${move.error}) after ${move.entries.length} of ${paths.length}; moved: ${move.entries.map((e) => e.from).join(", ") || "none"}.`,
    );
  return `Moved bot ${id} (file${paths.length > 1 ? " and memory" : ""}) to the trash for 7 days. Its channel goes away in a few seconds.`;
}
