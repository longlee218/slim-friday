import { choiceLayout } from "../ingress/discord-components";
import { type OwnerLanguage, renderUserNotice } from "../ingress/user-copy";
import { clip } from "../observability/redact";

/** Inline summary cap; longer text goes in the attachment. */
export const SUMMARY_MAX = 1500;

/** Chars of a long question kept inline as the stem above the buttons (the full text is the attachment). */
const STEM_MAX = 300;

/** Short stem of a long question: its first lines, cut, and a pointer to the attachment. */
const questionStem = (q: string, language: OwnerLanguage): string =>
  `${clip(q.trim(), STEM_MAX)}\n\n${renderUserNotice({ kind: "approval", state: "full-text" }, language)}`;

/**
 * Text, attachment and layout of an owner question.
 * A question longer than a Discord message (a plan to approve) goes out as an attachment under a short stem.
 * Options that do not fit a button row or a select menu are listed in the attachment; the owner types the answer.
 */
export function buildChoicePrompt(
  question: string,
  options: string[],
  language: OwnerLanguage,
): { layout: ReturnType<typeof choiceLayout>; text: string; detail?: string } {
  const layout = choiceLayout(options);
  const long = question.length > SUMMARY_MAX;
  const listed = layout === "modal" && options.length > 0;
  const detail = [long ? question : "", listed ? options.map((o) => `- ${o}`).join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
  const base = long ? questionStem(question, language) : question;
  const text = listed
    ? `${base}\n\n${renderUserNotice({ kind: "approval", state: "options-in-file" }, language)}`
    : base;
  return { layout, text, detail: detail || undefined };
}
