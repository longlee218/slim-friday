import type { ApprovalCardDto, MessageDto, QuestionCardDto } from "@friday/contracts";
import type { LiveRun, Receipt } from "../../events/client-keys";
import { markRuns, type RunPlace } from "./bubble-layout";
import { type ReactionCounts, reactionOfMessage } from "./reactions";

/** One row of the transcript, in display order. */
export type TranscriptItem =
  | { kind: "day"; key: string; at: number }
  | {
      kind: "message";
      key: string;
      message: MessageDto;
      pending?: "sending" | "failed";
      /** Emoji reactions folded under this message. */
      reactions?: ReactionCounts;
      /** Place in a run of one author's messages (set last, by `markRuns`). */
      place?: RunPlace;
    }
  | { kind: "approval"; key: string; card: ApprovalCardDto; receipt?: Receipt }
  | { kind: "question"; key: string; card: QuestionCardDto; receipt?: Receipt }
  | { kind: "run"; key: string; run: LiveRun; place?: RunPlace };

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
 * the first message of each local day, then the live runs, then this conversation's cards
 * (question receipts in arrival order, then the still-open ones; an answered approval is dropped): a card sits under the run block that
 * raised it, as in the prototype. A reaction whose target is loaded is no row of its own: it counts under that message.
 * Message and run rows carry their place in a run of one author. Keys are stable across renders.
 */
export function buildTranscriptItems(input: BuildInput): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const seen = new Set<number>();
  const loaded = new Set(input.pages.flat().map((m) => m.id));
  const reactions = new Map<number, ReactionCounts>();
  let day = Number.NaN;
  // Pages and their messages are newest first; walk both backwards to get oldest first.
  for (const page of [...input.pages].reverse()) {
    for (const message of [...page].reverse()) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const emoji = reactionOfMessage(message);
      const target = message.replyTo?.messageId;
      if (emoji && target !== undefined && target !== message.id && loaded.has(target)) {
        const counts = reactions.get(target) ?? {};
        reactions.set(target, { ...counts, [emoji]: (counts[emoji] ?? 0) + 1 });
        continue;
      }
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
  // Reactions come after their target in id order, so the counts are complete only now.
  for (const item of items) {
    const counts = item.kind === "message" ? reactions.get(item.message.id) : undefined;
    if (item.kind === "message" && counts) item.reactions = counts;
  }

  for (const run of Object.values(input.runs)) {
    items.push({ kind: "run", key: `r:${run.botId}`, run });
  }

  const here = (c: { conversationId: string }) => c.conversationId === input.conversationId;
  const cards = new Map<string, TranscriptItem>();
  // An answered approval leaves the transcript at once (no receipt line); its id is kept so a late
  // `approval.opened` cannot bring the card back.
  const answered = new Set<string>();
  for (const [cardId, r] of Object.entries(input.receipts)) {
    if (!here(r.card)) continue;
    if (r.kind === "approval") {
      answered.add(cardId);
      continue;
    }
    cards.set(cardId, { kind: "question", key: `q:${cardId}`, card: r.card, receipt: r });
  }
  for (const card of input.approvals) {
    if (here(card) && !cards.has(card.cardId) && !answered.has(card.cardId)) {
      cards.set(card.cardId, { kind: "approval", key: `a:${card.cardId}`, card });
    }
  }
  for (const card of input.questions) {
    if (here(card) && !cards.has(card.cardId)) {
      cards.set(card.cardId, { kind: "question", key: `q:${card.cardId}`, card });
    }
  }
  items.push(...cards.values());
  markRuns(items);
  return items;
}
