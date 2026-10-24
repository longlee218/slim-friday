import { type Bot, type BotHub, type BotId, type Store, ticketRef } from "@friday/core";
import type { CommandHandler } from "@friday/surface-discord";
import { purgeTrash } from "@friday/tools";

/** What the commands need from the app. */
interface CommandDeps {
  hub: BotHub;
  store: Pick<Store, "bots" | "groups" | "conversations" | "tickets">;
  /** The agent home (`/purge` empties `<home>/trash`). */
  home: string;
}

/** Most tickets `/tickets` shows. */
const TICKETS_SHOWN = 25;

/** `/status`, `/stop`, `/purge` and `/tickets` as plain text answers. */
export function appCommands({ hub, store, home }: CommandDeps): CommandHandler {
  /** Display name of every bot by id. */
  const names = async (): Promise<Map<BotId, Bot>> =>
    new Map((await store.bots.list()).map((b) => [b.id, b]));

  return async (c) => {
    if (c.name === "purge") return `Purged ${purgeTrash(home)} trash item(s).`;
    const bots = await names();
    const nameOf = (id: BotId) => bots.get(id)?.name ?? id;
    if (c.name === "tickets") {
      // Open = not done and not closed; the store hides closed, done is dropped here.
      const open = (await store.tickets.list({ excludeClosed: true, limit: 100 }))
        .filter((t) => t.status !== "done")
        .slice(0, TICKETS_SHOWN);
      return open.length
        ? open
            .map(
              (t) =>
                `${ticketRef(t.number)} [${t.status}] ${t.title} — ${t.assigneeBotId ? nameOf(t.assigneeBotId) : "unassigned"}`,
            )
            .join("\n")
        : "No open tickets.";
    }
    if (c.name === "status") {
      // One line per session; a group session names its group.
      const lines = hub
        .status()
        .map(
          (s) =>
            `${nameOf(s.botId)}${s.groupId ? ` in ${s.groupId}` : ""}: ${s.busy ? "busy" : "idle"}, ${s.tasks.length} background task(s)`,
        );
      return lines.length ? lines.join("\n") : "No bot is running.";
    }
    // `/stop @name`: every session of that bot.
    if (c.botName) {
      const wanted = c.botName.replace(/^@/, "").toLowerCase();
      const found = [...bots.values()].find((b) => b.name.toLowerCase() === wanted);
      if (!found) throw new Error(`No bot named ${c.botName}.`);
      await hub.stop(found.id);
      return `Stopped ${nameOf(found.id)}.`;
    }
    // Plain `/stop`: only the sessions of this channel (the bot's direct one, or the group's).
    const conv = await store.conversations.get(c.conversationId);
    if (!conv) throw new Error("No bot belongs to this channel.");
    if (conv.kind === "direct") {
      await hub.stop(conv.botId, "direct");
      return `Stopped ${nameOf(conv.botId)}.`;
    }
    await hub.stopGroup(conv.groupId);
    const members = (await store.groups.get(conv.groupId))?.members ?? [];
    return `Stopped ${members.map(nameOf).join(", ")}.`;
  };
}
