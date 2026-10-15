import { slashToLegacy } from "../commands/slash-commands";
import type { ModelTier, TaskClass } from "../config/model-routing";
import { parseMemoryCommand } from "../memory/memory-commands";

/** Fixed prompt of the Resume button after a restart (a message with exactly this text is a resume). */
export const RESUME_PROMPT =
  "The bot restarted while you were working. Continue the task from where you stopped.";

/** What an owner message means: a control command, or a plain message for a role with an optional location hint. */
export type MessageCommand =
  | { kind: "stop" }
  /** `/status`: what the thread's task is doing, answered by app code (no model). */
  | { kind: "status" }
  /** `/purge` (owner, thread scoped): empty the trash of this thread's goals now (answered by app code). */
  | { kind: "purge" }
  /** The Resume button: continue the thread's saved session. */
  | { kind: "resume"; extraBudgetUsd?: number }
  /**
   * `go` / `go +<usd>` (thread scoped, the handler decides): start the thread's pending proposal, else
   * resume its interrupted or budget-stopped task, with `extraBudgetUsd` more budget when given.
   */
  | { kind: "go"; extraBudgetUsd?: number }
  /** `forget:` / `compact memory` (see memory-commands.ts): answered by app code, never by the agent. `remember:` is NOT one: it is a plain message. */
  | { kind: "memory" }
  /**
   * A plain message (not a control command); the intent layer picks its role (no intent layer: the entry role).
   * `role` is never parsed: only a Resume of an interrupted or failed task sets it (that task's role starts again).
   * `location:<name>` is an optional hint.
   */
  | {
      kind: "message";
      role?: string;
      location?: string;
      text: string;
      cls?: TaskClass;
      tier?: ModelTier;
    };

/** Owner class prefix: `[mechanical]`, `[standard]`, `[design]` (wins over the intent layer's class). Unknown tags are not prefixes. */
const CLASS_PREFIX = /^\[(mechanical|standard|design)\]\s*/i;

/** Owner model prefix: `[sonnet]` forces Sonnet for a role that offers escalation (no confirm, no automatic fallback). Haiku/Opus are not prefixes (Opus needs the confirm gate). */
const TIER_PREFIX = /^\[(sonnet)\]\s*/i;

/** A role tag followed by `[sonnet]`: `[ask] [sonnet] q`. The tier is read and removed, the role tag stays for the router. */
const TAG_THEN_TIER = /^(\[[a-z0-9_-]+\])\s*\[sonnet\]\s*/i;

/** Largest `go +<usd>` raise accepted; a bigger (or non-finite) amount is a plain message. */
export const MAX_GO_EXTRA_USD = 1000;

/** `go` or `go +<usd>` (a positive amount, e.g. `go +1.5`); anything else is a normal message. */
const GO_COMMAND = /^go(?:\s+\+(\d+(?:\.\d+)?))?$/i;

/** Parse a message into one command. The only place that knows the `stop` / `location:` syntax (canonical `/stop`: legacy forms still work). */
export function parseMessageCommand(input: string): MessageCommand {
  const text = slashToLegacy(input).trim(); // L0: `/stop`, `/go` ... map onto the legacy forms below
  if (text.toLowerCase() === "stop") return { kind: "stop" };
  if (text.toLowerCase() === "status") return { kind: "status" };
  if (text.toLowerCase() === "purge") return { kind: "purge" };
  if (text === RESUME_PROMPT) return { kind: "resume" };
  const go = GO_COMMAND.exec(text);
  // `go +0` is not a raise: it stays a plain message.
  if (go && (go[1] === undefined || (Number(go[1]) > 0 && Number(go[1]) <= MAX_GO_EXTRA_USD)))
    return { kind: "go", ...(go[1] !== undefined && { extraBudgetUsd: Number(go[1]) }) };
  if (parseMemoryCommand(text)) return { kind: "memory" };
  // Prefixes come in any order: `[design] location:x ...` or `location:x [design] ...`; all are stripped from the brief.
  let rest = text;
  let cls: TaskClass | undefined;
  let tier: ModelTier | undefined;
  let location: string | undefined;
  for (let i = 0; i < 3; i++) {
    const c = !cls && CLASS_PREFIX.exec(rest);
    if (c) {
      cls = c[1]?.toLowerCase() as TaskClass;
      rest = rest.slice(c[0].length);
      continue;
    }
    const t = !tier && TIER_PREFIX.exec(rest);
    if (t) {
      tier = t[1]?.toLowerCase() as ModelTier;
      rest = rest.slice(t[0].length);
      continue;
    }
    const tt = !tier && TAG_THEN_TIER.exec(rest);
    if (tt) {
      tier = "sonnet";
      rest = `${tt[1]} ${rest.slice(tt[0].length)}`;
      continue;
    }
    const pin = !location && /^(?:location|repo):(\S+)\s*/i.exec(rest);
    if (pin) {
      location = pin[1];
      rest = rest.slice(pin[0].length);
    }
  }
  return { kind: "message", location, text: rest, ...(cls && { cls }), ...(tier && { tier }) };
}
