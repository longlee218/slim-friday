import type { ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import type { CardRow } from "@friday/core";
import { flattenSummary } from "./flatten-summary";

/** Longest tool input shown on an approval card, in code points (room for a long file Write; the card scrolls it). */
const INPUT_MAX = 200_000;

/** The input as pretty JSON, split into code points (so a cut never splits a surrogate pair). */
const inputPoints = (input: Record<string, unknown>): string[] => [
  ...(JSON.stringify(input, null, 2) ?? "{}"),
];

/** Whether the card shows less than the whole input; such a card can only be denied (the call is not fully shown). */
export function inputCut(input: Record<string, unknown>): boolean {
  return inputPoints(input).length > INPUT_MAX;
}

/** The exact input a one-shot approval binds, as pretty JSON; cut by code points, saying how much was cut. */
export function showInput(input: Record<string, unknown>): string {
  const points = inputPoints(input);
  return points.length > INPUT_MAX
    ? `${points.slice(0, INPUT_MAX).join("")} [CUT: ${points.length - INPUT_MAX} more chars]`
    : points.join("");
}

/** The approval DTO of a stored approval card; undefined for any other card. */
export function toApprovalDto(card: CardRow, botName: string): ApprovalCardDto | undefined {
  const a = card.approval;
  if (!a) return undefined;
  return {
    cardId: card.id,
    conversationId: card.conversationId,
    botId: card.botId,
    botName,
    tool: a.tool,
    summary: flattenSummary(a.summary),
    scope: a.scope,
    offerAlways: a.offerAlways,
    ...(a.offerAlways && a.always?.match === "site" && { alwaysSite: a.always.value }),
    input: showInput(a.input),
    inputCut: inputCut(a.input),
  };
}

/** The question DTO of a stored question card; undefined for any other card. */
export function toQuestionDto(card: CardRow, botName: string): QuestionCardDto | undefined {
  const q = card.question;
  if (!q) return undefined;
  return {
    cardId: card.id,
    conversationId: card.conversationId,
    botId: card.botId,
    botName,
    question: q.question,
    kind: q.kind,
    options: q.options,
    allowText: q.allowText,
  };
}
