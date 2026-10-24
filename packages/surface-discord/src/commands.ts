import type { DiscordPort } from "./discord-port";

/** A slash command as the app handles it. */
export interface CommandRequest {
  conversationId: string;
  name: "stop" | "status";
  botName?: string;
}

/** Runs a command and returns the text to show the owner. */
export type CommandHandler = (c: CommandRequest) => Promise<string>;

/** Owner-only slash commands: others are refused, a failing handler becomes a `Failed:` reply. */
export function registerCommands(port: DiscordPort, handler: CommandHandler): void {
  port.onCommand((c) => {
    void (async () => {
      if (c.userId !== port.ownerId) return c.reply("Only the owner can do that.");
      try {
        const text = await handler({
          conversationId: c.channelId,
          name: c.name,
          ...(c.botName && { botName: c.botName }),
        });
        await c.reply(text);
      } catch (err) {
        await c.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })().catch(() => {});
  });
}
