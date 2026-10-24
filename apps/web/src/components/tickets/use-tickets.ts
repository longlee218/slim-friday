import type { TicketDto } from "@friday/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { orpc } from "../../api/client";
import { TICKET_COLUMNS } from "./ticket-status";

type ListPage = { items: TicketDto[]; nextCursor?: string };

/**
 * The one list query of the board. `patchTicket` finds its cache by this exact input shape, so
 * every reader (board, sidebar count, drawer) must use these options.
 */
export const ticketListOptions = orpc.tickets.list.infiniteOptions({
  input: (cursor: string | undefined) => ({ cursor }),
  initialPageParam: undefined,
  getNextPageParam: (p: ListPage) => p.nextCursor,
});

/** Every ticket of the board: keeps fetching the next page until the cursor runs out. */
export function useAllTickets(): { tickets: TicketDto[]; isLoading: boolean } {
  const q = useInfiniteQuery(ticketListOptions);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q;
  const loaded = q.data?.pages.length ?? 0;
  // A failed page stops the chain (no retry storm); a refetch of the list starts it again. A new
  // page (`loaded`) re-runs the check even when the flags look unchanged between two commits.
  useEffect(() => {
    if (loaded > 0 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, loaded]);
  const tickets = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  return { tickets, isLoading: q.isLoading || hasNextPage === true };
}

/** Tickets per board column, newest first as served; `closed` has no column and is left out. */
export function groupByStatus(
  ts: TicketDto[],
): Record<(typeof TICKET_COLUMNS)[number], TicketDto[]> {
  const out = Object.fromEntries(TICKET_COLUMNS.map((c) => [c, [] as TicketDto[]])) as Record<
    (typeof TICKET_COLUMNS)[number],
    TicketDto[]
  >;
  for (const t of ts) if (t.status !== "closed") out[t.status].push(t);
  return out;
}

/** Tickets not yet done or closed (the sidebar badge and the toolbar subtitle). */
export const openCount = (ts: TicketDto[]): number =>
  ts.filter((t) => t.status !== "done" && t.status !== "closed").length;
