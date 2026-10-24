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

/** True when `a` sorts before `b` in the board list (server order: `createdAt` desc, then id desc). */
const sortsBefore = (a: TicketDto, b: TicketDto): boolean =>
  a.createdAt !== b.createdAt ? a.createdAt > b.createdAt : a.id > b.id;

/**
 * Inserts an unknown ticket into page 1 at its sort position, so a drawer opened on it right after
 * create shows it at once. Past the end of a page 1 that has more pages, it belongs on a later page
 * (not inserted, which would duplicate it); the list refetch places it.
 */
function insertIntoFirstPage(data: InfiniteData<ListPage>, t: TicketDto): InfiniteData<ListPage> {
  const [first, ...rest] = data.pages;
  if (!first) return data;
  const at = first.items.findIndex((x) => sortsBefore(t, x));
  if (at === -1 && first.nextCursor !== undefined) return data;
  const items = [...first.items];
  items.splice(at === -1 ? items.length : at, 0, t);
  return { ...data, pages: [{ ...first, items }, ...rest] };
}

/**
 * Puts a pushed ticket into the cache: replaces it by id in every unfiltered list page and in
 * `tickets.get`, drops a closed one from the pages, never goes back to an older `updatedAt`.
 * A filtered list is invalidated instead (the change may move the ticket out of its filter). A
 * live ticket that no page holds is inserted into page 1 of each unfiltered list and the list is
 * invalidated too (it may belong on a page not loaded). A newer version of a cached `tickets.get`
 * also invalidates it, so its timeline (comments, events) refetches.
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
  const getKey = orpc.tickets.get.queryKey({ input: { ref: t.ref } });
  const g = qc.getQueryData<TicketGet>(getKey);
  if (g && g.ticket.updatedAt <= t.updatedAt) {
    qc.setQueryData<TicketGet>(getKey, { ...g, ticket: t });
    // Only a strictly newer version can bring timeline items the cached get lacks.
    if (g.ticket.updatedAt < t.updatedAt)
      void qc.invalidateQueries({ queryKey: getKey, exact: true });
  }
  if (!found && t.status !== "closed") {
    for (const [key, data] of qc.getQueriesData<InfiniteData<ListPage>>({ queryKey: listKey() })) {
      if (data && !isFiltered(key)) qc.setQueryData(key, insertIntoFirstPage(data, t));
    }
    void qc.invalidateQueries({ queryKey: orpc.tickets.list.key() });
  }
}
