import { withEventMeta } from "@orpc/server";
import { logApiEvent } from "../api-log";
import { authed } from "../rpc/implementer";

/**
 * Where to resume: the input value or the SSE header. A valid integer >= 0 is used as is; a
 * present but invalid one is -1 (the bus answers `resync`); absent is undefined (live only).
 */
export function parseLastEventId(input?: number, header?: string): number | undefined {
  if (input !== undefined) return Number.isInteger(input) && input >= 0 ? input : -1;
  if (header === undefined || header === "") return undefined;
  return /^\d+$/.test(header) ? Number(header) : -1;
}

/** The live event stream; resumes from `input.lastEventId` or the SSE `Last-Event-ID` header. */
export const eventsRouter = {
  subscribe: authed.events.subscribe.handler(async function* ({
    input,
    context,
    signal,
    lastEventId,
  }) {
    const { surface, log } = context.deps;
    const resume = parseLastEventId(input.lastEventId, lastEventId);
    logApiEvent(log, "sse.open", { resume });
    try {
      for await (const { id, event } of surface.bus.subscribe(
        resume,
        signal ?? new AbortController().signal,
      )) {
        yield withEventMeta(event, { id: String(id) });
      }
    } finally {
      logApiEvent(log, "sse.close");
    }
  }),
};
