import { redactText } from "../../observability/redact";
import type { ProposeInput } from "./route-proposer";
import { routingMessageText } from "../routing-message-text";
import { cleanRecent } from "../recent-messages";

/** Longest task scope sent (already redacted at its source; clipped again here). */
const SCOPE_MAX_CHARS = 160;

/** The `state` object of one System One request: data only, all of it redacted and clipped. No pending question (those go to L3). */
export interface JevState extends Record<string, unknown> {
  message: string;
  thread: {
    state: string;
    task?: { owner: string; scope: string };
    lastRole?: string;
  };
  recent: { from: string; text: string }[];
}

/** Build the state. The message uses the same redact + clip as the Haiku L3 input (`routingMessageText`). */
export function buildJevState(input: ProposeInput): JevState {
  const { task, lastRole } = input;
  return {
    message: routingMessageText(input.text),
    thread: {
      state: input.state ?? "idle",
      ...(task && {
        task: {
          owner: task.ownerRole,
          scope: redactText(task.scope ?? "").slice(0, SCOPE_MAX_CHARS),
        },
      }),
      ...(lastRole && { lastRole }),
    },
    recent: cleanRecent(input.recent),
  };
}
