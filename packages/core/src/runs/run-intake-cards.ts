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

/**
 * The card branch of an owner message for one scope (spec "A message arrives", step 2). Returns true when the
 * message is used up as an answer:
 * - a card this same message answered before (a resend after a crash): its run is requeued if still parked;
 * - an open question of this conversation that allows text: answered once with the message id, run requeued.
 * A question that takes no text is withdrawn (with the other open questions of its run) and its run queued again (so it does not wait forever); an open
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
  const open = (await store.cards.openForScope(t.scopeKey)).filter(
    (c) => c.kind === "question" && c.conversationId === t.conversationId,
  );
  const question = open[0];
  if (!question) return false;
  if (question.question?.allowText && t.text.trim()) {
    const answer = { choices: [], text: t.text };
    // `answer` changes an open card once; a card answered meanwhile (web button) leaves the text to the next branch.
    const at = clock.now();
    if (!(await store.cards.answer(question.id, answer, at, t.messageId))) return false;
    closeOnSurface(ctx, { ...question, status: "answered", answer, answeredAt: at });
    await requeue(ctx, question);
    return true;
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
