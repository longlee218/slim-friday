import { realpathSync } from "node:fs";
import type { AskQuestion } from "../agent/tool-permissions";
import type { Repo, Workflow } from "../repos/repo-registry";
import type { FlowResult } from "./task-result";

/* Per-repo workflow and ask-timeout helpers of the code-task flow. */

/** Plan stage picks the repo itself: the `full` rules go in when any candidate repo is full (registry marks which). */
export const planWorkflow = (repos: Repo[]): Workflow =>
  repos.some((r) => r.workflow === "full") ? "full" : "lean";

/**
 * Execute-stage options of a repo's workflow. `full`: its rules, the trusted clone's skills, and the clone
 * readable (never writable) so skills can read their own files. `lean`: nothing extra (today's behavior).
 */
export function execWorkflow(repo: Repo): {
  workflow: Workflow;
  skillsFromClone?: string;
  readPaths: string[];
} {
  if (repo.workflow !== "full") return { workflow: "lean", readPaths: [] };
  const clone = realpathSync(repo.path);
  return { workflow: "full", skillsFromClone: clone, readPaths: [clone] };
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
