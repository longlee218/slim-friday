import type { BotId } from "../domain/bot";
import type { Conversation } from "../domain/conversation";
import { reactionOf } from "../domain/reaction";
import type { HubContext } from "../hub/hub-context";
import { hubTargets } from "../hub/hub-targets";
import type { WakeOpts } from "../hub/hub-types";
import { sessionScope } from "../hub/session-scope";
import type { InboundMessage } from "../ports/surface";
import { createRun } from "./run-create";
import { answerByText } from "./run-intake-cards";
import { intakeReaction } from "./run-intake-reaction";
import { steerIntoBusyScope } from "./run-intake-steer";
import { routeToTicket } from "./run-intake-ticket";
import { ownerRunKey, steeringId, supersede } from "./run-supersede";

/**
 * An owner message: store it (once per client nonce), then for every bot it addresses answer an open
 * question, comment on its ticket, steer a busy run of this conversation, or queue a new run.
 * Resolves with the stored id (undefined: unknown conversation).
 *
 * The store has no transaction across repos, so every routing write is idempotent per message and bot, and a
 * resend with the same nonce (`appendOnce` replayed) routes again to finish what a crash left undone:
 * 1. `appendOnce` by nonce;
 * 2. per bot, a card answered by this message (`answeredMessageId`) only has its run requeued again;
 *    an open question is answered once with the message id, then its parked run is requeued;
 * 3. in a group, a message about a ticket of the bot (see `routeToTicket`) becomes a comment with the id
 *    `owner-msg:<messageId>:<botId>`, a ticket wake with the key `owner-ticket:<messageId>:<botId>` and a
 *    system line with the nonce `owner-ticket-line:<messageId>:<botId>`; nothing below runs then;
 * 4. a steering row with the id `steer:<messageId>:<botId>` (a stored id is not added twice), or a run via
 *    `insertDeduped` with the key `owner:<messageId>:<botId>` (a busy run with that key means: routed already);
 * 5. supersede (see `supersede`), then hints.
 */
export async function intakeOwnerMessage(
  ctx: HubContext,
  m: InboundMessage,
): Promise<number | undefined> {
  const { store, clock } = ctx.deps;
  const conv = await store.conversations.get(m.conversationId);
  if (!conv) return undefined;
  // The owner writes again: caps announced in this conversation may be announced again.
  for (const k of [...ctx.noticed]) if (k.startsWith(`${conv.id}|`)) ctx.noticed.delete(k);
  const hasFiles = !!m.files?.length;
  const msg = {
    conversationId: conv.id,
    author: { kind: "user" as const },
    text: m.text,
    at: clock.now(),
    kind: hasFiles && !m.text.trim() ? ("file" as const) : ("text" as const),
    ...(m.replyTo !== undefined && { replyTo: m.replyTo }),
    ...(hasFiles && { files: m.files }),
  };
  let id: number;
  if (m.clientNonce === undefined) id = await store.messages.append(msg);
  else {
    // A replay routes again: the writes below are idempotent, so a crash after the append loses nothing.
    id = (await store.messages.appendOnce(msg, m.clientNonce)).id;
  }
  // A message of files only wakes the bot with a short note instead of an empty text.
  const runText = m.text.trim() || `(sent ${m.files?.length ?? 0} file(s))`;
  // A reply to a message of this conversation routes to its bot and carries the quoted text.
  const replied = m.replyTo === undefined ? undefined : await store.messages.get(m.replyTo);
  const quoted = replied?.conversationId === conv.id ? replied : undefined;
  const replyToBot = quoted?.author.kind === "bot" ? quoted.author.botId : undefined;
  // An emoji-only reply to a message of this conversation is a reaction, not a turn of its own.
  const emoji = reactionOf(m.text);
  if (emoji && quoted && !hasFiles) {
    await intakeReaction(ctx, { conv, messageId: id, emoji, target: quoted });
    return id;
  }
  const opts: WakeOpts = {
    ...(quoted && { quote: { author: quoted.author, text: quoted.text } }),
    ...(m.attachments && { attachments: m.attachments }),
  };
  for (const botId of await hubTargets(store, conv, m.text, replyToBot))
    await intakeForBot(ctx, { botId, conv, messageId: id, typed: m.text, runText, hasFiles, opts });
  return id;
}

/** One owner message for one addressed bot. */
interface BotIntake {
  /** The addressed bot. */
  botId: BotId;
  /** The conversation the message was sent in. */
  conv: Conversation;
  /** Stored id of the owner's message. */
  messageId: number;
  /** The text as typed (a question answer). */
  typed: string;
  /** The text a run or steering row carries. */
  runText: string;
  /** The message carries files. */
  hasFiles: boolean;
  /** Quote and files a new run carries. */
  opts: WakeOpts;
}

/** The branches for one bot, in the spec's order: question card, ticket, busy run of this conversation, new run. */
async function intakeForBot(ctx: HubContext, t: BotIntake): Promise<void> {
  const { store } = ctx.deps;
  const bot = await store.bots.get(t.botId);
  const group = t.conv.kind === "group" ? await store.groups.get(t.conv.groupId) : undefined;
  const scope = bot && sessionScope(bot, t.conv, group, ctx.deps.scopeBot);
  if (scope) {
    if (
      await answerByText(ctx, {
        scopeKey: scope.key,
        conversationId: t.conv.id,
        text: t.typed,
        messageId: t.messageId,
      })
    )
      return;
    if (await routeToTicket(ctx, t)) return;
    // A parked run (waiting_input) does not hold the scope; runs of another conversation do not take steering.
    const busy = (await store.wakes.activeInScope(scope.key)).filter(
      (w) => w.status !== "waiting_input" && w.conversationId === t.conv.id,
    );
    // A resend of a message that already started a run here: routed already.
    if (busy.some((w) => w.dedupeKey === ownerRunKey(t.messageId, t.botId))) return;
    const steer = {
      id: steeringId(t.messageId, t.botId),
      messageId: t.messageId,
      conversationId: t.conv.id,
      scopeKey: scope.key,
      text: t.runText,
      ...(t.opts.attachments && { attachments: t.opts.attachments }),
    };
    // A row whose host ended meanwhile is removed again; the message then starts its own run below.
    if (busy.length && (await steerIntoBusyScope(ctx, steer, busy))) return;
  }
  // No scope: `createRun` keeps the wake on record as dropped.
  const outcome = await createRun(ctx, {
    botId: t.botId,
    conversationId: t.conv.id,
    sender: { kind: "user" },
    text: t.runText,
    hop: 0,
    opts: t.opts,
    dedupeKey: ownerRunKey(t.messageId, t.botId),
  });
  if (outcome.ok && scope) await supersede(ctx, scope.key, t.conv.id, outcome.wakeId);
}
