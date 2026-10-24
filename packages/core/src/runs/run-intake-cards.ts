import type { CardRow } from "../domain/card";
import type { HubContext } from "../hub/hub-context";

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

/**
 * The card branch of an owner message for one scope (spec "A message arrives", step 2). Returns true when the
 * message is used up as an answer:
 * - a card this same message answered before (a resend after a crash): its run is requeued if still parked;
 * - an open question of this conversation that allows text: answered once with the message id, run requeued.
 * A question that takes no text is withdrawn and its run queued again (so it does not wait forever); an open
 * approval is left open. Then returns false and the message goes on to the steering / new run branch.
 */
export async function answerByText(ctx: HubContext, t: TypedText): Promise<boolean> {
  const { store, clock } = ctx.deps;
  const mine = (await store.cards.answeredByMessage(t.messageId)).find(
    (c) => c.scopeKey === t.scopeKey,
  );
  if (mine) {
    await requeue(ctx, mine);
    return true;
  }
  const question = (await store.cards.openForScope(t.scopeKey)).find(
    (c) => c.kind === "question" && c.conversationId === t.conversationId,
  );
  if (!question) return false;
  if (question.question?.allowText && t.text.trim()) {
    const answer = { choices: [], text: t.text };
    // `answer` changes an open card once; a card answered meanwhile (web button) leaves the text to the next branch.
    if (!(await store.cards.answer(question.id, answer, clock.now(), t.messageId))) return false;
    await requeue(ctx, question);
    return true;
  }
  if (await store.cards.setStatus(question.id, "open", "withdrawn")) await requeue(ctx, question);
  return false;
}

/**
 * Put the run that waited on `card` back to `queued`, then hint the workers. Guarded on `waiting_input`, its
 * fence, and no other open card of that run (a run that resumed and parked again on a newer card stays).
 * A run that is not parked (its worker still holds it while subagents run) is left alone; the hint lets that
 * worker apply the answer in place.
 */
async function requeue(ctx: HubContext, card: CardRow): Promise<void> {
  const { store } = ctx.deps;
  const run = await store.wakes.get(card.wakeId);
  if (run?.status === "waiting_input") {
    const open = await store.cards.openForScope(card.scopeKey);
    if (!open.some((c) => c.wakeId === run.id && c.id !== card.id))
      await store.wakes.transition(run.id, run.leaseFence, ["waiting_input"], { status: "queued" });
  }
  ctx.hints.cardAnswered(card.id);
}
