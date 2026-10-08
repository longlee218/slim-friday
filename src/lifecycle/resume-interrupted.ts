import type { Database } from "bun:sqlite";
import { ButtonStyle, type Client, type Interaction, MessageFlags } from "discord.js";
import { buildButtonRows } from "../approvals/approval-buttons";
import type { HandleTask } from "../ingress/discord-message-handler";
import { sendReply, startTyping } from "../ingress/discord-message-handler";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { ackInterrupted, listInterruptedThreads } from "../storage/run-store";
import { RESUME_PROMPT } from "../tasks/task-commands";

/** customId prefix of the Resume button: `resume:<threadId>:go` (same format as the approval buttons). */
const PREFIX = "resume";

const log = logger.child({ module: "resume-interrupted" });

/** Dependencies (the client is looked up lazily; it is created after the handler). */
export interface ResumeDeps {
  db: Database;
  getClient: () => Client | undefined;
  ownerId: string;
  handleTask: HandleTask;
  /** The one guild served (DISCORD_GUILD_ID); a button from another guild is ignored. */
  guildId?: string;
}

/**
 * Post a notice + Resume button in every thread with an interrupted task (once: the tasks are then
 * acknowledged). Call after Discord is ready. Returns the number of notices posted.
 */
export async function postResumeNotices(
  deps: Pick<ResumeDeps, "db" | "getClient">,
): Promise<number> {
  let posted = 0;
  for (const threadId of listInterruptedThreads(deps.db)) {
    try {
      const channel = await deps.getClient()?.channels.fetch(threadId);
      if (!channel?.isSendable()) throw new Error("no channel");
      await channel.send({
        content: "The bot restarted while a task was running. Press Resume to continue it.",
        components: buildButtonRows(PREFIX, threadId, [
          { label: "Resume", value: "go", style: ButtonStyle.Primary },
        ]),
        allowedMentions: SAFE_MENTIONS,
      });
      posted++;
      logEvent(log, "resume.offered", { threadId });
    } catch (err) {
      log.warn({ threadId, err: errText(err) }, "resume notice failed");
    }
    // Acknowledged either way: a deleted thread must not be retried at every start.
    ackInterrupted(deps.db, threadId);
  }
  return posted;
}

/** Interaction handler of the Resume button (owner only): run the thread with the fixed resume prompt. */
export function createResumeHandler(deps: ResumeDeps) {
  return async function handleResume(i: Interaction): Promise<void> {
    try {
      if (!i.isButton()) return;
      const [prefix, threadId] = i.customId.split(":");
      if (prefix !== PREFIX || !threadId) return;
      // Same rule as normal messages: with a pinned guild, other guilds are ignored (same reason code).
      if (deps.guildId && i.guildId !== deps.guildId) {
        logEvent(log, "message.ignored", { reason: "other_guild", via: "resume" });
        return;
      }
      if (i.user.id !== deps.ownerId) {
        await i.reply({ content: "Only the owner can resume.", flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = i.channel;
      // The button must live in the thread it names.
      if (i.channelId !== threadId || !channel?.isSendable()) return;
      // Routing key: the thread's parent channel (a button outside a thread is not ours).
      const channelId = channel.isThread() ? channel.parentId : null;
      if (!channelId) return;
      await i.update({ content: "Resuming...", components: [] });
      logEvent(log, "resume.clicked", { threadId });
      const stopTyping = startTyping(channel);
      try {
        const reply = await deps.handleTask({
          source: "discord",
          userId: deps.ownerId,
          threadId,
          channelId,
          text: RESUME_PROMPT,
        });
        await sendReply(channel, reply);
      } finally {
        stopTyping();
      }
    } catch (err) {
      log.warn({ err: errText(err) }, "resume interaction failed");
    }
  };
}
