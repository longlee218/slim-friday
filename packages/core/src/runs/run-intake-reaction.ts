import type { Conversation } from "../domain/conversation";
import type { IndexedMessage } from "../domain/message";
import { type Reaction, reactionOf } from "../domain/reaction";
import type { HubContext } from "../hub/hub-context";
import { sessionScope } from "../hub/session-scope";
import { createRun } from "./run-create";
import { answerQuestionWithText, openCardsFor } from "./run-intake-cards";

/** One owner reaction as the intake sees it. */
export interface ReactionIntake {
  conv: Conversation;
  /** Stored id of the reaction message. */
  messageId: number;
  emoji: Reaction;
  /** The message reacted to (a message of the same conversation). */
  target: IndexedMessage;
}

/** Newer messages looked at before the conversation counts as moved on. */
const NEWER_WINDOW = 50;

/** True when `m` is a reaction (an owner reply holding one emoji). */
const isReaction = (m: IndexedMessage): boolean =>
  m.author.kind === "user" && m.replyTo !== undefined && reactionOf(m.text) !== undefined;

/**
 * An owner reaction to a message (R§3 reactions). The reaction is stored already; it never steers a run and never
 * becomes an ordinary message turn. It wakes the bot that wrote the message only when all hold: the message is a
 * bot's, only reactions came after it (the conversation has not moved on), no run of that bot is busy in this
 * conversation and the bot was not woken by a reaction within `reactionCooldownMs`. The wake is a `reaction` run
 * that may stay silent. A 👍 or 👎 on a message of a run parked on a question answers it "yes" or "no" instead;
 * approval cards stay on their own buttons.
 */
export async function intakeReaction(ctx: HubContext, r: ReactionIntake): Promise<void> {
  const { store, clock } = ctx.deps;
  if (r.target.author.kind !== "bot") return;
  const botId = r.target.author.botId;
  const bot = await store.bots.get(botId);
  const group = r.conv.kind === "group" ? await store.groups.get(r.conv.groupId) : undefined;
  const scope = bot && sessionScope(bot, r.conv, group, ctx.deps.scopeBot);
  if (!scope) return;
  // Newest first; anything after the target that is not a reaction means the conversation moved on.
  const page = await store.messages.page(r.conv.id, { limit: NEWER_WINDOW + 1 });
  const newer = page.filter((m) => m.id > r.target.id);
  if (newer.length > NEWER_WINDOW || !newer.every(isReaction)) return;
  if (r.emoji === "👍" || r.emoji === "👎") {
    const ask = (await openCardsFor(ctx, scope.key)).find(
      (c) =>
        c.kind === "question" &&
        c.conversationId === r.conv.id &&
        c.wakeId === r.target.wakeId &&
        c.question?.allowText,
    );
    if (
      ask &&
      (await answerQuestionWithText(ctx, ask, r.emoji === "👍" ? "yes" : "no", r.messageId))
    )
      return;
  }
  const busy = (await store.wakes.activeInScope(scope.key)).some(
    (w) => w.status !== "waiting_input" && w.conversationId === r.conv.id,
  );
  if (busy) return;
  const now = clock.now();
  const last = ctx.reactedAt.get(scope.key);
  if (last !== undefined && now - last < ctx.limits.reactionCooldownMs) return;
  const outcome = await createRun(ctx, {
    botId,
    conversationId: r.conv.id,
    sender: { kind: "user" },
    text: `Reacted with ${r.emoji} to your message quoted above.`,
    hop: 0,
    opts: { reaction: r.emoji, quote: { author: r.target.author, text: r.target.text } },
    dedupeKey: `reaction:${r.messageId}:${botId}`,
  });
  if (outcome.ok) ctx.reactedAt.set(scope.key, now);
}
