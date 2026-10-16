import { parseSlash } from "../commands/slash-commands";
import { parseMemoryCommand } from "../memory/memory-commands";

/** What an owner message means: a slash control command, or a plain message (it goes to the thread's lead). */
export type MessageCommand =
  | { kind: "stop" }
  /** `/status`: what the thread's task is doing, answered by app code (no model). */
  | { kind: "status" }
  /** `/purge` (owner, thread scoped): empty the trash of this thread's goals now (answered by app code). */
  | { kind: "purge" }
  /** `/forget` / `/compact` (see memory-commands.ts): answered by app code, never by the agent. */
  | { kind: "memory" }
  /** Anything else, `/remember <text>` included (the agent saves the note); it goes to the lead. */
  | { kind: "message" };

/** Parse a message into one command. Commands are slash commands only: a text such as "stop" is a plain message. */
export function parseMessageCommand(input: string): MessageCommand {
  const slash = parseSlash(input);
  if (slash?.name === "stop" || slash?.name === "status" || slash?.name === "purge")
    return { kind: slash.name };
  if (parseMemoryCommand(input)) return { kind: "memory" };
  return { kind: "message" };
}
