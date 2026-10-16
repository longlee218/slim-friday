import type { AskQuestion } from "../../runtime/tool-permissions";
import type { FlowResult } from "../turns/turn-result";

/* The one control a role run needs besides its abort signal: what happens when the owner does not answer in time. */

/** Reply when the owner did not answer in time: the questions with their defaults, no guessing. */
export function awaitingText(questions: AskQuestion[]): string {
  const lines = questions.map((q) => {
    // The first option is the default; its label usually ends with "(default)": show it once.
    const def = q.options[0]?.label.replace(/\s*\(default\)\s*$/i, "");
    return `- ${q.question}${def ? ` (default: ${def})` : ""}`;
  });
  return `Awaiting clarification:\n${lines.join("\n")}\nSend a new request to continue.`;
}

/** The run stopped because the questions timed out: reply with them. The session is kept; a typed reply is a NEW request, it does not resume the run. */
export const awaitingResult = (res: FlowResult, text: string): FlowResult => ({
  ...res,
  text,
  outcome: "aborted",
  keepSession: true,
});

/**
 * Abort controller + ask-timeout callback of one role run. The controller follows the task's `parent` (`stop`,
 * shutdown). A timed-out question stops the run and reports `onAwaiting(text)`; but when the run is already aborted
 * (stop, shutdown) the unanswered ask is just cancelled: it must not be reported as "Awaiting clarification" nor
 * keep the session.
 */
export function askTimeoutControl(parent: AbortSignal, onAwaiting: (text: string) => void) {
  const ac = new AbortController();
  // An already-aborted parent never fires its listener: abort now, or the run could start after a `stop`.
  if (parent.aborted) ac.abort();
  else parent.addEventListener("abort", () => ac.abort(), { once: true });
  const onAskTimeout = (questions: AskQuestion[]): void => {
    if (ac.signal.aborted) return;
    onAwaiting(awaitingText(questions));
    ac.abort();
  };
  return { ac, onAskTimeout };
}
