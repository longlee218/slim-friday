import type { CardRow } from "../domain/card";
import type { HubContext } from "../hub/hub-context";
import { closeOnSurface, requeueForCard as requeue } from "./run-card-answer";

/** One owner message as the card branch sees it. */
export interface TypedText {
  /** Scope of the addressed bot. */
  scopeKey: string;
  /** Conversation the message was sent in. */
  conversationId: string;
  /** The text as typed. */
  text: string;
  /** Stored id of the owner message. */
  messageId: number;
}

/** How many recent messages are checked for a bot message newer than a question. */
const STALE_WINDOW = 20;

/** True when a bot message of the conversation was stored after `at`. */
async function botSpokeSince(
  ctx: HubContext,
  conversationId: string,
  at: number,
): Promise<boolean> {
  const recent = await ctx.deps.store.messages.recent(conversationId, STALE_WINDOW);
  return recent.some((m) => m.author.kind === "bot" && m.at > at);
}

/** Answer one open question with text, once, tied to the message; false when the card was answered meanwhile. */
export async function answerQuestionWithText(
  ctx: HubContext,
  question: CardRow,
  text: string,
  messageId: number,
): Promise<boolean> {
  const answer = { choices: [], text };
  const at = ctx.deps.clock.now();
  if (!(await ctx.deps.store.cards.answer(question.id, answer, at, messageId))) return false;
  closeOnSurface(ctx, { ...question, status: "answered", answer, answeredAt: at });
  await requeue(ctx, question);
  return true;
}

/**
 * The card branch of an owner message for one scope (spec "A message arrives", step 2). Returns true when the
 * message is used up as an answer:
 * - a card this same message answered before (a resend after a crash): its run is requeued if still parked;
 * - an open question of this conversation that allows text and is still the latest word (no bot message after it):
 *   answered once with the message id, run requeued.
 * A question that takes no text is withdrawn (with the other open questions of its run) and its run queued again (so it does not wait forever); an open
 * approval is left open. Then returns false and the message goes on to the steering / new run branch.
 */
export async function answerByText(ctx: HubContext, t: TypedText): Promise<boolean> {
  const { store } = ctx.deps;
  const mine = (await store.cards.answeredByMessage(t.messageId)).find(
    (c) => c.scopeKey === t.scopeKey,
  );
  if (mine) {
    await requeue(ctx, mine);
    return true;
  }
  const open = (await store.cards.openForScope(t.scopeKey)).filter(
    (c) => c.kind === "question" && c.conversationId === t.conversationId,
  );
  const question = open[0];
  if (!question) return false;
  if (question.question?.allowText && t.text.trim()) {
    // A bot posted after the question: it is stale, so the text is not its answer (the card stays open for its buttons).
    if (await botSpokeSince(ctx, t.conversationId, question.createdAt)) return false;
    // A card answered meanwhile (web button) leaves the text to the next branch.
    return answerQuestionWithText(ctx, question, t.text, t.messageId);
  }
  // Withdrawn: the resumed run is told so, and this message reaches it as steering (or a new run).
  // Every open question of that run goes (one call may have asked several), then the run is requeued once.
  let withdrawn = false;
  for (const q of open.filter((c) => c.wakeId === question.wakeId))
    if (await store.cards.setStatus(q.id, "open", "withdrawn")) {
      closeOnSurface(ctx, { ...q, status: "withdrawn" });
      withdrawn = true;
    }
  if (withdrawn) await requeue(ctx, question);
  return false;
}
