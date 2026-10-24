import type { BotId, BotRuntimeSpec, QuestionAnswer, QuestionCard } from "@friday/core";

/** Result shape of the SDK permission callback for one tool call. */
type AskResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** Reason sent to the bot when the owner leaves a question unanswered. */
const NO_ANSWER = "The owner did not answer in time.";

/** One question of the SDK `AskUserQuestion` input, as far as the cards need it. */
interface AskQuestion {
  question: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** True when `q` has a question text and a list of options with labels. */
function isAskQuestion(q: unknown): q is AskQuestion {
  const x = q as AskQuestion | null;
  return (
    !!x &&
    typeof x.question === "string" &&
    Array.isArray(x.options) &&
    x.options.every((o) => !!o && typeof o.label === "string")
  );
}

/** Exactly two options labelled yes and no (any case). */
function isYesNo(options: AskQuestion["options"]): boolean {
  const labels = options.map((o) => o.label.trim().toLowerCase()).sort();
  return labels.length === 2 && labels[0] === "no" && labels[1] === "yes";
}

/**
 * One question card per question of an `AskUserQuestion` input. A string is the reason the input is refused
 * (malformed). `multiSelect` is a `multi` card, a yes/no pair a `confirm`, the rest `single`; the owner may always type.
 */
export function cardsFromAsk(
  input: unknown,
  botId: BotId,
  botName: string,
  timeoutMs?: number,
): QuestionCard[] | string {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0)
    return "AskUserQuestion needs a non-empty questions list";
  if (!qs.every(isAskQuestion))
    return "AskUserQuestion questions need a question and options with labels";
  return qs.map((q) => ({
    botId,
    botName,
    question: q.question,
    kind: q.multiSelect ? "multi" : isYesNo(q.options) ? "confirm" : "single",
    options: q.options.map((o) => ({
      value: o.label,
      label: o.label,
      ...(o.description && { description: o.description }),
    })),
    allowText: true,
    ...(timeoutMs !== undefined && { timeoutMs }),
  }));
}

/**
 * The permission result that hands the owner's answers back to the model: `answers[question]` is the chosen labels
 * joined by ", ", or the typed text when nothing was chosen (with both, the text goes to `annotations[question].notes`).
 * Any missing answer (`null`) denies the call.
 */
export function answerAsk(
  input: Record<string, unknown>,
  answers: (QuestionAnswer | null)[],
): AskResult {
  const questions = (input.questions as AskQuestion[]).map((q) => q.question);
  const out: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const [i, question] of questions.entries()) {
    const a = answers[i];
    if (!a) return { behavior: "deny", message: NO_ANSWER };
    out[question] = a.choices.length ? a.choices.join(", ") : (a.text ?? "");
    if (a.choices.length && a.text) annotations[question] = { notes: a.text };
  }
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: out,
      ...(Object.keys(annotations).length && { annotations }),
    },
  };
}

/**
 * Puts each question of an `AskUserQuestion` call to the owner in turn through `spec.ask`. No `ask` or a throw is a
 * deny (the session goes on); an unanswered question is a deny too.
 */
export async function askOwner(
  spec: BotRuntimeSpec,
  input: Record<string, unknown>,
): Promise<AskResult> {
  if (!spec.ask) return { behavior: "deny", message: "No one can answer questions here." };
  const cards = cardsFromAsk(input, spec.bot.id, spec.bot.name);
  if (typeof cards === "string") return { behavior: "deny", message: cards };
  try {
    const answers: (QuestionAnswer | null)[] = [];
    for (const card of cards) {
      const a = await spec.ask(card);
      answers.push(a);
      if (!a) break;
    }
    return answerAsk(input, answers);
  } catch {
    return { behavior: "deny", message: "question failed" };
  }
}
