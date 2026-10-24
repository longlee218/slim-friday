import type { BotAddress, GroupId, ScopeBot } from "@friday/core";
import { withRoster } from "./roster";
import { sharedDirsFor, withSharedDirs } from "./shared-dirs";

/** What the scoping reads from the config (sync: it runs when a session opens). */
export interface ScopeConfig {
  /** Id, name and members of every group. */
  groupSummaries: () => { id: GroupId; name: string; members: string[] }[];
  /** Id, name and title of every bot. */
  botSummaries: () => BotAddress[];
}

/**
 * The hub's `scopeBot`: appends the shared-dir and roster text of the session's groups to the bot's instructions.
 * A group session gets that group's only; the direct session gets every group the bot is in. Only the text changes:
 * the hub sets a group session's workspaces itself.
 */
export function scopeBotFor(agentHome: string, config: ScopeConfig): ScopeBot {
  return (bot, groupId) => {
    const groups = config
      .groupSummaries()
      .filter((g) => g.members.includes(bot.id) && (groupId === undefined || g.id === groupId));
    const byId = new Map(config.botSummaries().map((b) => [b.id, b]));
    const rosters = groups.map((g) => ({
      name: g.name,
      members: g.members.flatMap((id) => byId.get(id) ?? []),
    }));
    const dirs = sharedDirsFor(agentHome, () => groups.map((g) => g.id))(bot.id);
    return withRoster(withSharedDirs(bot, dirs), rosters);
  };
}
