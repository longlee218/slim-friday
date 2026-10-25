import type { BotStatusDto } from "@friday/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { orpc } from "../api/client";
import { patchTicket } from "../components/tickets/ticket-cache";
import { closeApproval, closeQuestion, openApproval, openQuestion } from "./apply-cards";
import { appendMessage, setUnread } from "./apply-messages";
import { endRun, endRunsExcept, runStep, runTail, startRun } from "./apply-runs";
import type { CacheEffect } from "./event-reducer";

/** Toast callback type. */
export type Notify = (n: Extract<CacheEffect, { op: "notify" }>) => void;

/** Burst window of the `control.status` refetch. */
const STATUS_DEBOUNCE_MS = 1000;

/** Pending refetch timer per query client (one fetch per burst). */
const statusTimers = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();

/** Cancels a pending status refetch (tests). */
export function resetStatusDebounce(qc: QueryClient): void {
  const t = statusTimers.get(qc);
  if (t) clearTimeout(t);
  statusTimers.delete(qc);
}

/** Writes a status list into the cache and ends the runs of bots that are not working. */
function setStatus(qc: QueryClient, bots: BotStatusDto[]): void {
  qc.setQueryData(orpc.control.status.queryKey(), bots);
  endRunsExcept(qc, new Set(bots.filter((b) => b.working).map((b) => b.botId)));
}

/** Schedules one `control.status` fetch for the burst, then applies it like a `status` event. */
export function refetchStatus(qc: QueryClient): void {
  if (statusTimers.has(qc)) return;
  statusTimers.set(
    qc,
    setTimeout(() => {
      statusTimers.delete(qc);
      qc.fetchQuery(orpc.control.status.queryOptions({ staleTime: 0 }))
        .then((bots) => {
          setStatus(qc, bots);
          // The Activity page's session table reads `ops.sessions`; refresh it on the same burst.
          void qc.invalidateQueries({ queryKey: orpc.ops.sessions.key() });
        })
        // A failed refetch leaves the old status; the next event retries.
        .catch(() => {});
    }, STATUS_DEBOUNCE_MS),
  );
}

/** Applies reducer effects to the query cache; `notify` effects go to the callback. */
export function applyEffects(qc: QueryClient, effects: CacheEffect[], notify: Notify): void {
  for (const e of effects) {
    switch (e.op) {
      case "appendMessage":
        appendMessage(qc, e.message);
        break;
      case "endRun":
        endRun(qc, e.conversationId, e.botId);
        break;
      case "startRun":
        startRun(qc, e.conversationId, e.botId, e.at, true);
        break;
      case "runStep":
        runStep(qc, e.conversationId, e.botId, e.step);
        break;
      case "runTail":
        runTail(qc, e.conversationId, e.botId, e.label);
        break;
      case "openApproval":
        openApproval(qc, e.card);
        break;
      case "closeApproval":
        closeApproval(qc, e.cardId, e.answer);
        break;
      case "openQuestion":
        openQuestion(qc, e.card);
        break;
      case "closeQuestion":
        closeQuestion(qc, e.cardId, e.answer);
        break;
      case "setUnread":
        setUnread(qc, e.conversationId, e.unread);
        break;
      case "setStatus":
        setStatus(qc, e.bots);
        break;
      case "refetchStatus":
        refetchStatus(qc);
        break;
      case "patchTicket":
        patchTicket(qc, e.ticket);
        break;
      case "invalidate":
        if (e.scope === "all") void qc.invalidateQueries();
        else if (e.scope === "tickets") void qc.invalidateQueries({ queryKey: orpc.tickets.key() });
        else {
          void qc.invalidateQueries({ queryKey: orpc.config.key() });
          // The engine syncs conversations before it sends config.changed (new or removed bots).
          void qc.invalidateQueries({ queryKey: orpc.conversations.list.key() });
        }
        break;
      case "notify":
        notify(e);
        break;
    }
  }
}
