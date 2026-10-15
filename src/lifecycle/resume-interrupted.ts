import type { Database } from "bun:sqlite";
import { ButtonStyle, type Client, type Interaction, MessageFlags } from "discord.js";
import { buildButtonRows } from "../approvals/approval-buttons";
import { threadLanguage } from "../ingress/discord-components";
import type { HandleMessage } from "../ingress/discord-message-handler";
import { sendReply, startTyping } from "../ingress/discord-message-handler";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { renderUserNotice } from "../ingress/user-copy";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { RESUME_PROMPT } from "../orchestrator/message-commands";
import { ackInterrupted, listInterruptedThreads } from "../storage/run-store";

/** customId prefix of the Resume button: `resume:<threadId>:go` (same format as the approval buttons). */
const PREFIX = "resume";

const log = logger.child({ module: "resume-interrupted" });

/** Dependencies (the client is looked up lazily; it is created after the handler). */
export interface ResumeDeps {
  db: Database;
  getClient: () => Client | undefined;
  ownerId: string;
  handleMessage: HandleMessage;
  /** The one guild served (DISCORD_GUILD_ID); a button from another guild is ignored. */
  guildId?: string;
  /** True for a channel mapped with `mode: chat` (the owner talks in it inline, so Resume works there too). */
  isChatChannel?: (id: string) => boolean;
}

/**
 * Post a notice + Resume button in every thread with an interrupted task (once: the tasks are then
 * acknowledged; a control channel is only acknowledged, never offered). Call after Discord is ready. Returns the number of notices posted.
 */
export async function postResumeNotices(
  deps: Pick<ResumeDeps, "db" | "getClient"> & { isControlChannel?: (id: string) => boolean },
): Promise<number> {
  let posted = 0;
  for (const threadId of listInterruptedThreads(deps.db)) {
    // The control channel has no Resume flow (its Continue button would be dead): just close the row.
    if (deps.isControlChannel?.(threadId)) {
      ackInterrupted(deps.db, threadId);
      continue;
    }
    try {
      const channel = await deps.getClient()?.channels.fetch(threadId);
      if (!channel?.isSendable()) throw new Error("no channel");
      const language = threadLanguage(deps.db, threadId);
      await channel.send({
        content: renderUserNotice({ kind: "decision", state: "restart" }, language),
        components: buildButtonRows(PREFIX, threadId, [
          {
            label: language === "vi" ? "Tiếp tục" : "Continue",
            value: "go",
            style: ButtonStyle.Primary,
          },
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
        await i.reply({
          content: renderUserNotice(
            { kind: "failure", cause: "owner" },
            threadLanguage(deps.db, threadId),
          ),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = i.channel;
      // The button must live in the thread it names.
      if (i.channelId !== threadId || !channel?.isSendable()) return;
      // Routing key: the thread's parent channel, or the chat channel itself (any other channel is not ours).
      const channelId = channel.isThread()
        ? channel.parentId
        : deps.isChatChannel?.(channel.id)
          ? channel.id
          : null;
      if (!channelId) return;
      await i.update({
        content: renderUserNotice(
          { kind: "decision", state: "resuming" },
          threadLanguage(deps.db, threadId),
        ),
        components: [],
      });
      logEvent(log, "resume.clicked", { threadId });
      const stopTyping = startTyping(channel);
      const language = threadLanguage(deps.db, threadId);
      try {
        const reply = await deps.handleMessage({
          source: "discord",
          userId: deps.ownerId,
          threadId,
          channelId,
          text: RESUME_PROMPT,
          // The prompt is English; the owner's pinned language decides the notices and the result.
          language,
        });
        if (reply !== undefined) await sendReply(channel, reply, language);
      } finally {
        stopTyping();
      }
    } catch (err) {
      log.warn({ err: errText(err) }, "resume interaction failed");
    }
  };
}
