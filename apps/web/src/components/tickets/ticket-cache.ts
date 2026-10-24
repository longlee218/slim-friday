import type { TicketDto } from "@friday/contracts";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc } from "../../api/client";

type ListPage = { items: TicketDto[]; nextCursor?: string };
type TicketGet = { ticket: TicketDto; timeline: unknown[]; related: TicketDto[] };

/**
 * Infinite-list query key prefix (the `infinite` type marker is what separates it from the
 * plain `tickets.list` key); matches every input, like `messagesKey` in plan 3.
 */
const listKey = () =>
  orpc.tickets.list.infiniteKey({
    input: (cursor: string | undefined) => ({ cursor }),
    initialPageParam: undefined,
  });

/** True when a list query's input filters by status or assignee (a patch could break its filter). */
function isFiltered(key: readonly unknown[]): boolean {
  const input = (key[1] as { input?: { status?: unknown; assignee?: unknown } } | undefined)?.input;
  return input?.status !== undefined || input?.assignee !== undefined;
}

/**
 * Puts a pushed ticket into the cache: replaces it by id in every unfiltered list page and in
 * `tickets.get`, drops a closed one from the pages, never goes back to an older `updatedAt`.
 * A filtered list is invalidated instead (the change may move the ticket out of its filter). A
 * live ticket that no page holds invalidates the list (it may belong on a page not loaded).
 */
export function patchTicket(qc: QueryClient, t: TicketDto): void {
  let found = false;
  for (const [key, data] of qc.getQueriesData<InfiniteData<ListPage>>({ queryKey: listKey() })) {
    if (!data?.pages.some((p) => p.items.some((x) => x.id === t.id))) continue;
    found = true;
    if (isFiltered(key)) {
      void qc.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    // Only a newer (or same) version replaces or removes the cached ticket.
    const newer = (x: TicketDto) => x.id === t.id && x.updatedAt <= t.updatedAt;
    qc.setQueryData<InfiniteData<ListPage>>(key, {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items:
          t.status === "closed"
            ? p.items.filter((x) => !newer(x))
            : p.items.map((x) => (newer(x) ? t : x)),
      })),
    });
  }
  qc.setQueryData<TicketGet>(orpc.tickets.get.queryKey({ input: { ref: t.ref } }), (g) =>
    g && g.ticket.updatedAt <= t.updatedAt ? { ...g, ticket: t } : g,
  );
  if (!found && t.status !== "closed") {
    void qc.invalidateQueries({ queryKey: orpc.tickets.list.key() });
  }
}
