import { slashToLegacy } from "../commands/slash-commands";
import type { TaskClass } from "../config/model-routing";
import { parseMemoryCommand } from "../memory/memory-commands";

/** Fixed prompt of the Resume button after a restart (a message with exactly this text is a resume). */
export const RESUME_PROMPT =
  "The bot restarted while you were working. Continue the task from where you stopped.";

/** What an owner message means: a control command, or a plain message for a role with an optional repo hint. */
export type MessageCommand =
  | { kind: "stop" }
  /** The Resume button: continue the thread's saved session. */
  | { kind: "resume"; extraBudgetUsd?: number }
  /**
   * `go` / `go +<usd>` (thread scoped, the handler decides): start the thread's pending proposal, else
   * resume its interrupted or budget-stopped task, with `extraBudgetUsd` more budget when given.
   */
  | { kind: "go"; extraBudgetUsd?: number }
  /** `remember:` / `forget:` / `compact memory` (see memory-commands.ts): answered by app code, never by the agent. */
  | { kind: "memory" }
  /**
   * A plain message (not a control command); the intent layer picks its role (no intent layer: the entry role).
   * `role` is never parsed: only a Resume of an interrupted or failed task sets it (that task's role starts again).
   * `repo:<name>` is an optional hint.
   */
  | { kind: "message"; role?: string; repo?: string; text: string; cls?: TaskClass };

/** Owner class prefix: `[mechanical]`, `[standard]`, `[design]` (wins over the intent layer's class). Unknown tags are not prefixes. */
const CLASS_PREFIX = /^\[(mechanical|standard|design)\]\s*/i;

/** Largest `go +<usd>` raise accepted; a bigger (or non-finite) amount is a plain message. */
export const MAX_GO_EXTRA_USD = 1000;

/** `go` or `go +<usd>` (a positive amount, e.g. `go +1.5`); anything else is a normal message. */
const GO_COMMAND = /^go(?:\s+\+(\d+(?:\.\d+)?))?$/i;

/** Parse a message into one command. The only place that knows the `stop` / `repo:` syntax (canonical `/stop`: legacy forms still work). */
export function parseMessageCommand(input: string): MessageCommand {
  const text = slashToLegacy(input).trim(); // L0: `/stop`, `/go` ... map onto the legacy forms below
  if (text.toLowerCase() === "stop") return { kind: "stop" };
  if (text === RESUME_PROMPT) return { kind: "resume" };
  const go = GO_COMMAND.exec(text);
  // `go +0` is not a raise: it stays a plain message.
  if (go && (go[1] === undefined || (Number(go[1]) > 0 && Number(go[1]) <= MAX_GO_EXTRA_USD)))
    return { kind: "go", ...(go[1] !== undefined && { extraBudgetUsd: Number(go[1]) }) };
  if (parseMemoryCommand(text)) return { kind: "memory" };
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
  return { kind: "message", repo, text: rest, ...(cls && { cls }) };
}
