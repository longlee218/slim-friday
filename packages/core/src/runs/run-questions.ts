import type { CardRow } from "../domain/card";
import type { QuestionAnswer, QuestionCard } from "../domain/question";
import type { HubContext } from "../hub/hub-context";
import { WAITING_TEXT } from "../permission/permission-gate";
import type { AskResult } from "../ports/agent-runtime";
import { questionContinuation } from "./approval-continuation";
import { waitOrPark } from "./run-cards";
import type { RunExec } from "./run-exec";

/**
 * The cards of one bot call share an ask id: card ids are `<askId>.<index>` (no new column; the question JSON
 * stays one `QuestionCard` per card, so the web shows each question as its own card).
 */
export const askIdOf = (cardId: string): string => cardId.slice(0, cardId.lastIndexOf("."));

/**
 * The questions of one `AskUserQuestion` call as stored cards, one per question, all shown at once. Each card
 * is then waited on in order: answered in place while background tasks run, else the run parks (on the card it
 * waits for) and every answer comes with the resume (`questionsResume`). A run that already waits on a card,
 * or a question withdrawn in place, is refused with the reason the bot reads.
 */
export async function askInRun(
  ctx: HubContext,
  exec: RunExec,
  qs: QuestionCard[],
): Promise<AskResult> {
  const { store, clock, surface } = ctx.deps;
  const { row, bot } = exec;
  if ((await store.cards.openForScope(row.scopeKey)).some((c) => c.wakeId === row.id))
    return { behavior: "refused", reason: WAITING_TEXT };
  const askId = `card-${crypto.randomUUID()}`;
  const cards: CardRow[] = qs.map((q, i) => ({
    id: `${askId}.${i}`,
    kind: "question",
    wakeId: row.id,
    botId: bot.id,
    conversationId: exec.current.conversationId,
    scopeKey: row.scopeKey,
    question: { ...q, botId: bot.id, botName: bot.name },
    status: "open",
    createdAt: clock.now(),
  }));
  for (const card of cards) await store.cards.insert(card);
  for (const card of cards) {
    try {
      surface.showCard(card, bot.name);
    } catch {
      // The stored card is the truth; a restart shows it again.
    }
  }
  const answers: QuestionAnswer[] = [];
  for (const card of cards) {
    const r = await waitOrPark(ctx, exec, card.id);
    if (r === "parked") return { behavior: "park", cardId: card.id };
    if (r.status === "withdrawn" || !r.answer || typeof r.answer === "string")
      return { behavior: "refused", reason: questionContinuation(r) };
    answers.push(r.answer);
  }
  return { behavior: "answered", answers };
}

/**
 * The resume of a run parked on question card `card`: every card of the same call, in order, each as the reply
 * to its question (or its withdrawn note). A card of the call still open means the run parks again (`open`).
 */
export async function questionsResume(
  ctx: HubContext,
  card: CardRow,
): Promise<{ text: string } | "open"> {
  const askId = askIdOf(card.id);
  const all = (await ctx.deps.store.cards.forWake(card.wakeId)).filter(
    (c) => c.kind === "question" && askIdOf(c.id) === askId,
  );
  const group = all.length > 0 ? all : [card];
  if (group.some((c) => c.status === "open")) return "open";
  return { text: group.map(questionContinuation).join("\n") };
}
