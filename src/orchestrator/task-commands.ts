import type { TaskClass } from "../config/model-routing";
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
  | { kind: "code" | "qa"; repo?: string; text: string; cls?: TaskClass };

/** Owner class prefix: `[mechanical]`, `[standard]`, `[design]` (wins over the intent layer's class). Unknown tags are not prefixes. */
const CLASS_PREFIX = /^\[(mechanical|standard|design)\]\s*/i;

/** Parse a message into one command. The only place that knows the `stop` / `cleanup:` / `repo:` syntax. */
export function parseTaskCommand(input: string): TaskCommand {
  const text = input.trim();
  if (text.toLowerCase() === "stop") return { kind: "stop" };
  if (text === RESUME_PROMPT) return { kind: "resume" };
  if (parseMemoryCommand(text)) return { kind: "memory" };
  const cleanup = /^cleanup:\s*(\S*)/i.exec(text);
  if (cleanup) return { kind: "cleanup", taskId: cleanup[1] || undefined };
  // Prefixes come in either order: `[design] repo:x ...` or `repo:x [design] ...`; both are stripped from the brief.
  let rest = text;
  let cls: TaskClass | undefined;
  let repo: string | undefined;
  for (let i = 0; i < 2; i++) {
    const c = !cls && CLASS_PREFIX.exec(rest);
    if (c) {
      cls = c[1]?.toLowerCase() as TaskClass;
      rest = rest.slice(c[0].length);
      continue;
    }
    const pin = !repo && /^repo:(\S+)\s*/i.exec(rest);
    if (pin) {
      repo = pin[1];
      rest = rest.slice(pin[0].length);
    }
  }
  return { kind: "qa", repo, text: rest, ...(cls && { cls }) };
}
