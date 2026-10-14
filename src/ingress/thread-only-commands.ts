import { parseMessageCommand } from "../orchestrator/message-commands";
import type { UserNotice } from "./user-copy";

/** The note for a command that only makes sense inside a thread (`/stop`, `/status`) sent elsewhere; undefined for any other text. */
export function threadOnlyNote(prompt: string): UserNotice | undefined {
  const kind = parseMessageCommand(prompt).kind;
  if (kind === "stop") return { kind: "note", state: "stop-in-thread" };
  if (kind === "status") return { kind: "note", state: "status-in-thread" };
  return undefined;
}
