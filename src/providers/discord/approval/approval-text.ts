import { type OwnerLanguage, renderUserNotice } from "../../../ingress/user-copy";
import { clip } from "../../../observability/redact";
import { choiceLayout } from "../ui/components/choice";

/** Inline summary cap; longer text goes in the attachment. */
export const SUMMARY_MAX = 1500;

/** Chars of a long question kept inline as the stem above the buttons (the full text is the attachment). */
const STEM_MAX = 300;

/** Chars of a stem the caller wrote (a plan summary): room left for the attachment notice under SUMMARY_MAX. */
const GIVEN_STEM_MAX = SUMMARY_MAX - 200;

/** Attachment name of a long owner question. */
export const CHOICE_FILE_NAME = "question.txt";

/** Short stem of a long question: its first lines (or the caller's own stem), cut, and a pointer to the attachment. */
const questionStem = (q: string, language: OwnerLanguage, max = STEM_MAX): string =>
  `${clip(q.trim(), max)}\n\n${renderUserNotice({ kind: "approval", state: "full-text" }, language)}`;

/**
 * Text, attachment and layout of an owner question.
 * A question longer than a Discord message (a plan to approve) goes out as an attachment under a short stem.
 * Options that do not fit a button row or a select menu are listed in the attachment; the owner types the answer.
 */
export function buildChoicePrompt(
  question: string,
  options: string[],
  language: OwnerLanguage,
  stem?: string,
): { layout: ReturnType<typeof choiceLayout>; text: string; detail?: string } {
  const layout = choiceLayout(options);
  const long = question.length > SUMMARY_MAX;
  const listed = layout === "modal" && options.length > 0;
  const detail = [long ? question : "", listed ? options.map((o) => `- ${o}`).join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
  const base = !long
    ? question
    : stem
      ? questionStem(stem, language, GIVEN_STEM_MAX)
      : questionStem(question, language);
  const text = listed
    ? `${base}\n\n${renderUserNotice({ kind: "approval", state: "options-in-file" }, language)}`
    : base;
  return { layout, text, detail: detail || undefined };
}
