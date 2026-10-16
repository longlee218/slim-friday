import { slashToLegacy } from "../commands/slash-commands";
import { parseMemoryCommand } from "../memory/memory-commands";

/** What an owner message means: a control command, or a plain message with an optional location hint. */
export type MessageCommand =
  | { kind: "stop" }
  /** `/status`: what the thread's task is doing, answered by app code (no model). */
  | { kind: "status" }
  /** `/purge` (owner, thread scoped): empty the trash of this thread's goals now (answered by app code). */
  | { kind: "purge" }
  /** `forget:` / `compact memory` (see memory-commands.ts): answered by app code, never by the agent. `remember:` is NOT one: it is a plain message. */
  | { kind: "memory" }
  /** A plain message (not a control command); it goes to the thread's lead. `location:<name>` is an optional hint. */
  | { kind: "message"; location?: string; text: string };

/** Parse a message into one command. The only place that knows the `stop` / `location:` syntax (canonical `/stop`: legacy forms still work). */
export function parseMessageCommand(input: string): MessageCommand {
  const text = slashToLegacy(input).trim(); // L0: `/stop`, `/status` ... map onto the legacy forms below
  if (text.toLowerCase() === "stop") return { kind: "stop" };
  if (text.toLowerCase() === "status") return { kind: "status" };
  if (text.toLowerCase() === "purge") return { kind: "purge" };
  if (parseMemoryCommand(text)) return { kind: "memory" };
  // The optional `location:<name>` hint is stripped from the text.
  const pin = /^(?:location|repo):(\S+)\s*/i.exec(text);
  return { kind: "message", location: pin?.[1], text: pin ? text.slice(pin[0].length) : text };
}
