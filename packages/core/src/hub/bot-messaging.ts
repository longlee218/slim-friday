import type { Bot } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { SendRequest, SendResult } from "../ports/messenger";
import { clampBotMessage, nextHop } from "../routing/bot-messages";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";
import { postStored } from "./post-stored";
import type { PoolEntry } from "./session-pool";

/** A bot's `SendToBot` / `HandOff` from session `sessionKey`: deliver a message to a member of its group. */
export async function sendFromSession(
  ctx: HubContext,
  sessionKey: string,
  req: SendRequest,
): Promise<SendResult> {
  const entry = ctx.pool.entry(sessionKey);
  // Read now: the entry moves on to its next turn while this call awaits.
  const wakeId = entry?.currentWakeId;
  if (!entry || !wakeId || !entry.current.conversationId)
    return { ok: false, error: "You can send a message only while you answer one." };
  return deliver(ctx, entry, { ...entry.current, wakeId }, req, true);
}

/**
 * Check one bot-to-bot message and wake its target. `cur` is the wake the sender is answering; `post` shows the
 * message in the channel under the sender's name (an automatic result is the bot's own text, already shown).
 */
async function deliver(
  ctx: HubContext,
  entry: PoolEntry,
  cur: { conversationId: ConversationId; hop: number; wakeId: string },
  req: SendRequest,
  post: boolean,
): Promise<SendResult> {
  const { store, clock } = ctx.deps;
  const fail = (error: string): SendResult => ({ ok: false, error });
  const text = clampBotMessage(req.text);
  if (!text) return fail("The message is empty.");
  const conv = await store.conversations.get(cur.conversationId);
  if (conv?.kind !== "group") return fail("Messages between bots work in group chats only.");
  const group = await store.groups.get(conv.groupId);
  const members = (
    await Promise.all((group?.members ?? []).map((id) => store.bots.get(id)))
  ).filter((b): b is Bot => b !== undefined);
  const q = req.to.trim();
  const named = members.filter((b) => b.name.toLowerCase() === q.toLowerCase());
  const target = members.find((b) => b.id === q) ?? (named.length === 1 ? named[0] : undefined);
  if (!target) return fail(`No member of this group has the id or name "${q}".`);
  if (target.id === entry.bot.id) return fail("A bot cannot message itself.");

  const parent = await store.wakes.get(cur.wakeId);
  const hop = nextHop(cur.hop);
  const fromTarget = parent?.sender.kind === "bot" && parent.sender.botId === target.id;
  // A result or status going back to the bot that gave the work may pass the hop limit.
  const returnsToSender =
    fromTarget &&
    (req.intent === "result" || req.intent === "status") &&
    (parent?.intent === "request" || parent?.intent === "question") &&
    !parent?.handoff;
  if (hop > ctx.limits.maxHops && !returnsToSender)
    return fail(
      "The limit of bot-to-bot messages for this chain is reached; report to the owner instead of messaging another bot.",
    );
  if (req.handoff && fromTarget)
    return fail(
      "Do not hand this step back to the bot that gave it to you; post the result in the channel instead.",
    );

  const author: Author = { kind: "bot", botId: entry.bot.id };
  const outcome = await ctx.wake(target.id, conv.id, author, text, hop, {
    intent: req.intent,
    ...(req.handoff && { handoff: true }),
    ...(parent && { chainId: parent.chainId }),
    parentWakeId: cur.wakeId,
    ...(returnsToSender && { exemptFromHops: true }),
  });
  if (!outcome.ok) return fail(`Not delivered: the ${outcome.reason} limit is reached.`);
  if (req.intent === "result") entry.sentResults.add(target.id);
  if (post) {
    // A relay is its own message kind; the surface shows the hand-off from its fields.
    const state = req.intent === "question" || req.intent === "status" ? req.intent : undefined;
    await postStored(ctx.deps, {
      conversationId: conv.id,
      author,
      text,
      at: clock.now(),
      kind: "relay",
      relay: {
        fromBotId: entry.bot.id,
        toBotId: target.id,
        intent: req.handoff ? "handoff" : req.intent === "result" ? "result" : "request",
        ...(state && { state }),
      },
    }).catch((err) =>
      ctx.deps.log?.error({ error: errText(err), conversationId: conv.id }, "hub.post_failed"),
    );
  }
  return {
    ok: true,
    wakeId: outcome.wakeId,
    note: req.handoff
      ? `Handed to ${target.name}. End this turn without narrating it; ${target.name} owns the step now.`
      : `Sent to ${target.name}. Delivery is asynchronous; an answer wakes you later as a new message. Continue independent work and send another update only if it adds something new.`,
  };
}

/**
 * A turn woken by a request or question ends: its last text goes back to the sender as a result, unless the bot
 * already sent that sender a result in this turn. A hand-off is never answered this way.
 */
export async function returnOutcome(ctx: HubContext, e: PoolEntry): Promise<void> {
  if (!e.currentWakeId) return;
  const w = await ctx.deps.store.wakes.get(e.currentWakeId);
  if (w?.sender.kind !== "bot" || w.handoff) return;
  if (w.intent !== "request" && w.intent !== "question") return;
  if (e.sentResults.has(w.sender.botId)) return;
  const text = e.turnTexts.at(-1);
  if (!text?.trim()) return;
  const res = await deliver(
    ctx,
    e,
    { conversationId: w.conversationId, hop: w.hop, wakeId: w.id },
    { to: w.sender.botId, text, intent: "result" },
    false,
  );
  if (!res.ok) ctx.deps.log?.warn({ error: res.error, wakeId: w.id }, "hub.result_not_returned");
}
