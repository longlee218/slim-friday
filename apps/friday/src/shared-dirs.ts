import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "@friday/core";

/**
 * The shared dir of every group a bot is in (`<AGENT_HOME>/shared/<groupId>/`), created on the way. Members of one
 * group read and write the same dir, so a document one bot writes is readable by the others; the rest of the agent
 * home stays denied. A bot in no group gets none.
 */
export function sharedDirsFor(home: string, groupIdsOf: (botId: string) => string[]) {
  return (botId: string): string[] =>
    groupIdsOf(botId).map((gid) => {
      const dir = join(home, "shared", gid);
      mkdirSync(dir, { recursive: true });
      return dir;
    });
}

/** Tell the bot where its group folders are (appended to its instructions); unchanged without any. */
export function withSharedDirs(bot: Bot, dirs: string[]): Bot {
  if (dirs.length === 0) return bot;
  const lines = dirs.map((d) => `- ${d}`).join("\n");
  return {
    ...bot,
    instructions: `${bot.instructions}\n\nShared folders (every member of the group reads and writes them; put documents the others need there and name the path when you hand off):\n${lines}`,
  };
}
