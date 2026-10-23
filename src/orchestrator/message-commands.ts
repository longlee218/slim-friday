import { parseSlash } from "../commands/slash-commands";

/** What an owner message means: a slash control command, or a plain message (it goes to the thread's teammate). */
export type MessageCommand =
  | { kind: "stop" }
  /** `/status`: what the thread's task is doing, answered by app code (no model). */
  | { kind: "status" }
  /** `/purge` (owner, thread scoped): empty the trash of this thread's goals now (answered by app code). */
  | { kind: "purge" }
  /** Anything else; it goes to the teammate. */
  | { kind: "message" };

/** Parse a message into one command. Commands are slash commands only: a text such as "stop" is a plain message. */
export function parseMessageCommand(input: string): MessageCommand {
  const slash = parseSlash(input);
  if (slash?.name === "stop" || slash?.name === "status" || slash?.name === "purge")
    return { kind: slash.name };
  return { kind: "message" };
}
