import { withEventMeta } from "@orpc/server";
import { logApiEvent } from "../api-log";
import { authed } from "../rpc/implementer";

/** The live event stream; resumes from `input.lastEventId` or the SSE `Last-Event-ID` header. */
export const eventsRouter = {
  subscribe: authed.events.subscribe.handler(async function* ({
    input,
    context,
    signal,
    lastEventId,
  }) {
    const { surface, log } = context.deps;
    const resume = input.lastEventId ?? (Number(lastEventId) || undefined);
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
