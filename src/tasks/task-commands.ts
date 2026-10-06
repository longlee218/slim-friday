/** Fixed prompt of the Resume button after a restart (a message with exactly this text is a resume). */
export const RESUME_PROMPT =
  "The bot restarted while you were working. Continue the task from where you stopped.";

/** What an owner message means: a control command, or a Q&A / code task with an optional repo hint. */
export type TaskCommand =
  | { kind: "stop" }
  /** The Resume button: continue the thread's saved session (see `resolveResume`). */
  | { kind: "resume" }
  /** `cleanup:` removes this thread's worktree; `cleanup:<task-id>` a specific one. */
  | { kind: "cleanup"; taskId?: string }
  /** `task:` = code task (plan, approval, worktree); otherwise Q&A. `repo:<name>` is an optional hint. */
  | { kind: "code" | "qa"; repo?: string; text: string };

/** Parse a message into one command. The only place that knows the `stop` / `cleanup:` / `task:` / `repo:` syntax. */
export function parseTaskCommand(input: string): TaskCommand {
  const text = input.trim();
  if (text.toLowerCase() === "stop") return { kind: "stop" };
  if (text === RESUME_PROMPT) return { kind: "resume" };
  const cleanup = /^cleanup:\s*(\S*)/i.exec(text);
  if (cleanup) return { kind: "cleanup", taskId: cleanup[1] || undefined };
  const task = /^task:\s*/i.exec(text);
  const rest = task ? text.slice(task[0].length) : text;
  const pin = /^repo:(\S+)\s*/i.exec(rest);
  return {
    kind: task ? "code" : "qa",
    repo: pin?.[1],
    text: pin ? rest.slice(pin[0].length) : rest,
  };
}
