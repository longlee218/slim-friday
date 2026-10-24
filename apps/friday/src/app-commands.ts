import type { Bot, BotHub, BotId, Store } from "@friday/core";
import type { CommandHandler } from "@friday/surface-discord";
import { purgeTrash } from "@friday/tools";

/** What the commands need from the app. */
interface CommandDeps {
  hub: BotHub;
  store: Pick<Store, "bots" | "groups" | "conversations">;
  /** The agent home (`/purge` empties `<home>/trash`). */
  home: string;
}

/** `/status`, `/stop` and `/purge` as plain text answers. */
export function appCommands({ hub, store, home }: CommandDeps): CommandHandler {
  /** Display name of every bot by id. */
  const names = async (): Promise<Map<BotId, Bot>> =>
    new Map((await store.bots.list()).map((b) => [b.id, b]));

  return async (c) => {
    if (c.name === "purge") return `Purged ${purgeTrash(home)} trash item(s).`;
    const bots = await names();
    const nameOf = (id: BotId) => bots.get(id)?.name ?? id;
    if (c.name === "status") {
      const lines = hub
        .status()
        .map(
          (s) =>
            `${nameOf(s.botId)}: ${s.busy ? "busy" : "idle"}, ${s.tasks.length} background task(s)`,
        );
      return lines.length ? lines.join("\n") : "No bot is running.";
    }
    let ids: BotId[];
    if (c.botName) {
      const wanted = c.botName.replace(/^@/, "").toLowerCase();
      const found = [...bots.values()].find((b) => b.name.toLowerCase() === wanted);
      if (!found) throw new Error(`No bot named ${c.botName}.`);
      ids = [found.id];
    } else {
      const conv = await store.conversations.get(c.conversationId);
      if (!conv) throw new Error("No bot belongs to this channel.");
      ids =
        conv.kind === "direct"
          ? [conv.botId]
          : ((await store.groups.get(conv.groupId))?.members ?? []);
    }
    for (const id of ids) await hub.stop(id);
    return `Stopped ${ids.map(nameOf).join(", ")}.`;
  };
}
