import type { Bot } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { SendRequest, SendResult } from "../ports/messenger";
import { clampBotMessage, nextHop } from "../routing/bot-messages";
import { sendKeyFor } from "../runs/outcome-outbox";
import { createRun } from "../runs/run-create";
import type { RunExec } from "../runs/run-exec";
import { redactSecrets, secretsFrom } from "../safety/redact-secrets";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";
import { postStored } from "./post-stored";

/** A bot's `SendToBot` / `HandOff` from session `sessionKey`: deliver a message to a member of its group. */
export async function sendFromSession(
  ctx: HubContext,
  sessionKey: string,
  req: SendRequest,
): Promise<SendResult> {
  // The run of this scope executing in this process; a send is accepted only while it is live.
  const exec = ctx.runs.get(sessionKey);
  if (!exec?.live) return { ok: false, error: "You can send a message only while you answer one." };
  return deliver(ctx, exec, { ...exec.current, wakeId: exec.row.id }, req);
}

/**
 * Check one bot-to-bot message and wake its target. `cur` is the wake the sender is answering. The run is
 * stored under `sendKeyFor` (this execution's count of identical sends), so the same call made again after a
 * cut finds the first run (`replayed`) instead of waking the target twice. The automatic result of a finished
 * run is not sent here (`returnOutcome`).
 */
async function deliver(
  ctx: HubContext,
  entry: RunExec,
  cur: { conversationId: ConversationId; hop: number; wakeId: string },
  req: SendRequest,
): Promise<SendResult> {
  const { store, clock } = ctx.deps;
  const fail = (error: string): SendResult => ({ ok: false, error });
  // Redacted before anything is stored: the target's wake, its dedupe key and the relay line.
  const text = redactSecrets(clampBotMessage(req.text), secretsFrom(ctx.deps.secretValues));
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
  const hash = `${target.id}|${req.intent}|${req.handoff ? "h" : "-"}|${text}`;
  const n = (entry.sendCounts.get(hash) ?? 0) + 1;
  entry.sendCounts.set(hash, n);
  const outcome = await createRun(ctx, {
    botId: target.id,
    conversationId: conv.id,
    sender: author,
    text,
    hop,
    opts: {
      intent: req.intent,
      ...(req.handoff && { handoff: true }),
      ...(parent && { chainId: parent.chainId }),
      parentWakeId: cur.wakeId,
      ...(returnsToSender && { exemptFromHops: true }),
    },
    dedupeKey: await sendKeyFor(
      cur.wakeId,
      entry.row.cardId,
      target.id,
      req.intent,
      !!req.handoff,
      text,
      n,
    ),
  });
  if (!outcome.ok) return fail(`Not delivered: the ${outcome.reason} limit is reached.`);
  // A replay was posted by the first call; the channel shows each send once.
  if (!outcome.replayed) {
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
    ...(outcome.replayed && { replayed: true }),
    note: req.handoff
      ? `Handed to ${target.name}. End this turn without narrating it; ${target.name} owns the step now.`
      : `Sent to ${target.name}. Delivery is asynchronous; an answer wakes you later as a new message. Continue independent work and send another update only if it adds something new.`,
  };
}
