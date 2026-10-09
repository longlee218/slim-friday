import { parseMemoryCommand } from "../memory/memory-commands";

/** Fixed prompt of the Resume button after a restart (a message with exactly this text is a resume). */
export const RESUME_PROMPT =
  "The bot restarted while you were working. Continue the task from where you stopped.";

/** What an owner message means: a control command, or a Q&A / code task with an optional repo hint. */
export type TaskCommand =
  | { kind: "stop" }
  /** The Resume button: continue the thread's saved session. */
  | { kind: "resume" }
  /** `cleanup:` removes this thread's worktree; `cleanup:<task-id>` a specific one. */
  | { kind: "cleanup"; taskId?: string }
  /** `remember:` / `forget:` / `compact memory` (see memory-commands.ts): answered by app code, never by the agent. */
  | { kind: "memory" }
  /**
   * Every plain message is Q&A (the agent hands code changes over with its `DelegateTask` tool). `code` is
   * never parsed: only a Resume of an interrupted plan stage builds it. `repo:<name>` is an optional hint.
   */
  | { kind: "code" | "qa"; repo?: string; text: string };

/** Parse a message into one command. The only place that knows the `stop` / `cleanup:` / `repo:` syntax. */
export function parseTaskCommand(input: string): TaskCommand {
  const text = input.trim();
  if (text.toLowerCase() === "stop") return { kind: "stop" };
  if (text === RESUME_PROMPT) return { kind: "resume" };
  if (parseMemoryCommand(text)) return { kind: "memory" };
  const cleanup = /^cleanup:\s*(\S*)/i.exec(text);
  if (cleanup) return { kind: "cleanup", taskId: cleanup[1] || undefined };
  const pin = /^repo:(\S+)\s*/i.exec(text);
  return { kind: "qa", repo: pin?.[1], text: pin ? text.slice(pin[0].length) : text };
}
