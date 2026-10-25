import type { CardRow } from "../domain/card";
import type { QuestionAnswer } from "../domain/question";
import { type HubContext, tell } from "../hub/hub-context";
import type { ApprovalAnswer } from "../ports/surface";

/** Result of answering a card from a surface. */
export type AnswerCardResult = "ok" | "conflict" | "not_found" | "bad_answer";

/** Whether `answer` fits the card: one of the approval answers ("always" only when offered), or choices among the options and/or text. */
export function validCardAnswer(card: CardRow, answer: unknown): boolean {
  // "always" only on a card that offers it.
  if (card.kind === "approval")
    return (
      answer === "once" ||
      answer === "deny" ||
      (answer === "always" && !!card.approval?.offerAlways)
    );
  const q = card.question;
  const a = answer as QuestionAnswer | null;
  if (!q || !a || typeof a !== "object" || !Array.isArray(a.choices)) return false;
  const text = typeof a.text === "string" ? a.text.trim() : "";
  if (a.text !== undefined && typeof a.text !== "string") return false;
  if (text && !q.allowText) return false;
  if (a.choices.length === 0 && !text) return false;
  if (q.kind !== "multi" && a.choices.length > 1) return false;
  const values = new Set(q.options.map((o) => o.value));
  return a.choices.every((c) => typeof c === "string" && values.has(c));
}

/**
 * The owner answers a card (main process). The guarded `cards.answer` (open -> answered, once) is the commit
 * point; then: "always" on a card that offers it adds the owner rule, the answer is audited, the surface closes the
 * card, and the run is requeued (parked) or told in place (still running with background tasks).
 * Crash order: a crash after the answer and before the requeue leaves the run `waiting_input` with an answered
 * card; the main sweep (`remindWaitingCards`) requeues it.
 */
export async function answerCard(
  ctx: HubContext,
  cardId: string,
  answer: ApprovalAnswer | QuestionAnswer,
): Promise<AnswerCardResult> {
  const { store, clock } = ctx.deps;
  const card = await store.cards.get(cardId);
  if (!card) return "not_found";
  if (card.status !== "open") return "conflict";
  if (!validCardAnswer(card, answer)) return "bad_answer";
  const now = clock.now();
  if (!(await store.cards.answer(cardId, answer, now))) return "conflict";
  const a = card.approval;
  // "Always" stores an `always_allow` rule: the card's site (a fetch) or the tool with its scope.
  if (a && answer === "always" && a.offerAlways)
    await store.grants.add({
      id: `grant-${card.botId}-${a.always?.value ?? a.tool}-${now}`,
      botId: card.botId,
      effect: "always_allow",
      match: a.always?.match ?? "tool",
      tool: a.always?.value ?? a.tool,
      scope: a.always ? {} : a.scope,
      createdAt: now,
    });
  if (a)
    await store.audit.append({
      at: now,
      botId: card.botId,
      tool: a.tool,
      outcome: "ask",
      answer: answer as ApprovalAnswer,
      reason: "answered by the owner",
    });
  closeOnSurface(ctx, { ...card, status: "answered", answer, answeredAt: now });
  await requeueForCard(ctx, card);
  return "ok";
}

/** Close a card on the surface; a surface failure never stops the caller (the row is the truth). */
export function closeOnSurface(ctx: HubContext, card: CardRow): void {
  try {
    ctx.deps.surface.closeCard(card);
  } catch {
    // Best effort.
  }
}

/**
 * Put the run that waited on `card` back to `queued`, then hint the workers. Guarded on `waiting_input`, its
 * fence, and no other open card of that run (a run that resumed and parked again on a newer card stays).
 * A run that is not parked (its worker still holds it while background tasks run) is left alone; the hint
 * lets that worker apply the answer in place.
 */
export async function requeueForCard(ctx: HubContext, card: CardRow): Promise<void> {
  const { store } = ctx.deps;
  const run = await store.wakes.get(card.wakeId);
  if (run?.status === "waiting_input") {
    const open = await store.cards.openForScope(card.scopeKey);
    if (!open.some((c) => c.wakeId === run.id))
      await store.wakes.transition(run.id, run.leaseFence, ["waiting_input"], { status: "queued" });
  }
  ctx.hints.cardAnswered(card.id);
}

/** The line that names what a card waits for. */
const subject = (c: CardRow) =>
  c.approval ? `approve ${c.approval.summary}` : `answer "${c.question?.question ?? ""}"`;

/**
 * Main sweep. Every open card older than `cardReminderMs` that was never reminded gets one reminder in its
 * conversation (marked first, so a crash never reminds twice; no card is ever cancelled). Every run still
 * `waiting_input` whose card is no longer open (a crash between the answer and the requeue) is requeued.
 */
export async function remindWaitingCards(ctx: HubContext, now: number): Promise<void> {
  const { store } = ctx.deps;
  for (const card of await store.cards.open()) {
    if (card.remindedAt !== undefined || now - card.createdAt < ctx.limits.cardReminderMs) continue;
    await store.cards.markReminded(card.id, now);
    const name = (await store.bots.get(card.botId))?.name ?? card.botId;
    await tell(ctx, card.conversationId, `${name} is still waiting for you to ${subject(card)}.`);
  }
  for (const run of await store.wakes.waiting()) {
    const card = run.cardId ? await store.cards.get(run.cardId) : undefined;
    if (card && card.status !== "open") await requeueForCard(ctx, card);
  }
}
