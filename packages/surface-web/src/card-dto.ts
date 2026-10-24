import type { ApprovalCardDto, QuestionCardDto } from "@friday/contracts";
import type { CardRow } from "@friday/core";
import { flattenSummary } from "./flatten-summary";

/** Longest tool input shown on an approval card, in code points. */
const INPUT_MAX = 2000;

/** The exact input a one-shot approval binds, as pretty JSON; cut by code points, saying how much was cut. */
export function showInput(input: Record<string, unknown>): string {
  const points = [...(JSON.stringify(input, null, 2) ?? "{}")];
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
    input: showInput(a.input),
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
