import type { ApprovalCardDto, MessageDto, QuestionCardDto } from "@friday/contracts";
import type { LiveRun, Receipt } from "../../events/client-keys";

/** One row of the transcript, in display order. */
export type TranscriptItem =
  | { kind: "day"; key: string; at: number }
  | { kind: "message"; key: string; message: MessageDto; pending?: "sending" | "failed" }
  | { kind: "approval"; key: string; card: ApprovalCardDto; receipt?: Receipt }
  | { kind: "question"; key: string; card: QuestionCardDto; receipt?: Receipt }
  | { kind: "run"; key: string; run: LiveRun };

export interface BuildInput {
  /** Query pages, newest page first; each page is newest first too. */
  pages: MessageDto[][];
  approvals: ApprovalCardDto[];
  questions: QuestionCardDto[];
  /** This session's closed cards, in order of arrival. */
  receipts: Record<string, Receipt>;
  runs: Record<string, LiveRun>;
  conversationId: string;
  /** Local state of unconfirmed owner messages, by temp id. */
  pending?: Record<number, "sending" | "failed">;
}

/** Midnight (local) of the day `t` falls on; the key of a day line. */
const dayStart = (t: number): number => new Date(t).setHours(0, 0, 0, 0);

/**
 * Flattens the query pages into the transcript: messages oldest first with a day line before
 * the first message of each local day, then this conversation's cards (receipts in arrival
 * order, then the still-open ones), then the live runs. Keys are stable across renders.
 */
export function buildTranscriptItems(input: BuildInput): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const seen = new Set<number>();
  let day = Number.NaN;
  // Pages and their messages are newest first; walk both backwards to get oldest first.
  for (const page of [...input.pages].reverse()) {
    for (const message of [...page].reverse()) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const d = dayStart(message.at);
      if (d !== day) {
        day = d;
        items.push({ kind: "day", key: `d:${d}`, at: message.at });
      }
      const pending = input.pending?.[message.id];
      items.push({
        kind: "message",
        key: `m:${message.id}`,
        message,
        ...(pending && { pending }),
      });
    }
  }

  const here = (c: { conversationId: string }) => c.conversationId === input.conversationId;
  const cards = new Map<string, TranscriptItem>();
  for (const [cardId, r] of Object.entries(input.receipts)) {
    if (!here(r.card)) continue;
    cards.set(
      cardId,
      r.kind === "approval"
        ? { kind: "approval", key: `a:${cardId}`, card: r.card, receipt: r }
        : { kind: "question", key: `q:${cardId}`, card: r.card, receipt: r },
    );
  }
  for (const card of input.approvals) {
    if (here(card) && !cards.has(card.cardId)) {
      cards.set(card.cardId, { kind: "approval", key: `a:${card.cardId}`, card });
    }
  }
  for (const card of input.questions) {
    if (here(card) && !cards.has(card.cardId)) {
      cards.set(card.cardId, { kind: "question", key: `q:${card.cardId}`, card });
    }
  }
  items.push(...cards.values());

  for (const run of Object.values(input.runs)) {
    items.push({ kind: "run", key: `r:${run.botId}`, run });
  }
  return items;
}
