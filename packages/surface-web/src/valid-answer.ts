import type { QuestionCardDto } from "@friday/contracts";
import type { QuestionAnswer } from "@friday/core";

/** Whether a question answer fits the card; the card stays open when it does not. */
export function validAnswer(dto: QuestionCardDto, a: QuestionAnswer): boolean {
  const text = a.text?.trim();
  if (text && !dto.allowText) return false;
  if (a.choices.length === 0 && !text) return false;
  if (dto.kind !== "multi" && a.choices.length > 1) return false;
  const values = new Set(dto.options.map((o) => o.value));
  return a.choices.every((c) => values.has(c));
}
