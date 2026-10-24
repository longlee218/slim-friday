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

/**
 * Puts a pushed ticket into the cache: replaces it by id in every list page and in
 * `tickets.get`, drops a closed one from the pages, never goes back to an older `updatedAt`.
 * A live ticket that no page holds invalidates the list (it may belong on a page not loaded).
 */
export function patchTicket(qc: QueryClient, t: TicketDto): void {
  let found = false;
  for (const [key, data] of qc.getQueriesData<InfiniteData<ListPage>>({ queryKey: listKey() })) {
    if (!data?.pages.some((p) => p.items.some((x) => x.id === t.id))) continue;
    found = true;
    qc.setQueryData<InfiniteData<ListPage>>(key, {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items:
          t.status === "closed"
            ? p.items.filter((x) => x.id !== t.id)
            : p.items.map((x) => (x.id === t.id && x.updatedAt <= t.updatedAt ? t : x)),
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
