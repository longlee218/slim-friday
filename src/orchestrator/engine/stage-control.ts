import type { Repo, Workflow } from "../../repos/repo-registry";
import type { AskQuestion } from "../../runtime/tool-permissions";
import type { FlowResult } from "../turns/turn-result";

/* Per-repo workflow and ask-timeout helpers of the code-task flow. */

/** Plan stage picks the repo itself: the `full` rules go in when any candidate repo is full (registry marks which). */
export const planWorkflow = (repos: Repo[]): Workflow =>
  repos.some((r) => r.workflow === "full") ? "full" : "lean";

/**
 * Execute-stage options of a repo's workflow: `full` adds the repo's own rules to the prompt, `lean` nothing extra.
 * Skills come from the workspace for both (see buildRunSkills). Dev reads are not limited to paths (the guard only
 * denies secret files), so nothing needs to be made readable here.
 */
export function execWorkflow(repo: Repo): { workflow: Workflow } {
  return { workflow: repo.workflow === "full" ? "full" : "lean" };
}

/** Reply when the owner did not answer in time: the questions with their defaults, no guessing. */
export function awaitingText(questions: AskQuestion[]): string {
  const lines = questions.map((q) => {
    // The first option is the default; its label usually ends with "(default)": show it once.
    const def = q.options[0]?.label.replace(/\s*\(default\)\s*$/i, "");
    return `- ${q.question}${def ? ` (default: ${def})` : ""}`;
  });
  return `Awaiting clarification:\n${lines.join("\n")}\nReply in this thread to continue.`;
}

/** The stage stopped because the questions timed out: reply with them; keep the session so a reply resumes it. */
export const awaitingResult = (res: FlowResult, text: string): FlowResult => ({
  ...res,
  text,
  outcome: "aborted",
  keepSession: true,
});

/**
 * Abort controller + ask-timeout callback of one stage run (plan or exec). The controller follows the task's
 * `parent` (`stop`, shutdown). A timed-out question stops the stage and reports `onAwaiting(text)`; but when
 * the stage is already aborted (stop, shutdown, run timeout) the unanswered ask is just cancelled: it must
 * not be reported as "Awaiting clarification" nor keep the session.
 */
export function stageControl(parent: AbortSignal, onAwaiting: (text: string) => void) {
  const ac = new AbortController();
  // An already-aborted parent never fires its listener: abort now, or exec could start after a `stop`.
  if (parent.aborted) ac.abort();
  else parent.addEventListener("abort", () => ac.abort(), { once: true });
  const onAskTimeout = (questions: AskQuestion[]): void => {
    if (ac.signal.aborted) return;
    onAwaiting(awaitingText(questions));
    ac.abort();
  };
  return { ac, onAskTimeout };
}
