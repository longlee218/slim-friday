import type { TicketDto } from "@friday/contracts";
import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { patchTicket } from "../../src/components/tickets/ticket-cache";

type Page = { items: TicketDto[]; nextCursor?: string };
type Get = { ticket: TicketDto; timeline: never[]; related: TicketDto[] };

const t = (id: string, over: Partial<TicketDto> = {}): TicketDto => ({
  id,
  ref: `FRI-${id}`,
  number: Number(id),
  title: `t${id}`,
  status: "todo",
  priority: "normal",
  createdBy: { kind: "user" },
  createdAt: 1,
  updatedAt: 10,
  commentCount: 0,
  ...over,
});

/** The list key as Task 8's `useAllTickets` builds it (same options, so it cannot drift). */
const listOptions = orpc.tickets.list.infiniteOptions({
  input: (cursor: string | undefined) => ({ cursor }),
  initialPageParam: undefined,
  getNextPageParam: (p: Page) => p.nextCursor,
});

let qc: QueryClient;
const pages = () => qc.getQueryData<InfiniteData<Page>>(listOptions.queryKey)!.pages;
const getKey = (ref: string) => orpc.tickets.get.queryKey({ input: { ref } });

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData<InfiniteData<Page, string | undefined>>(listOptions.queryKey, {
    pages: [{ items: [t("1"), t("2")], nextCursor: "c" }, { items: [t("3")] }],
    pageParams: [undefined, "c"],
  });
  qc.setQueryData<Get>(getKey("FRI-2"), { ticket: t("2"), timeline: [], related: [] });
});

describe("patchTicket", () => {
  test("replaces a cached ticket in list pages and in get", () => {
    patchTicket(qc, t("2", { status: "doing", updatedAt: 20 }));
    expect(pages()[0]!.items[1]!.status).toBe("doing");
    expect(pages()[0]!.nextCursor).toBe("c");
    expect(qc.getQueryData<Get>(getKey("FRI-2"))!.ticket.status).toBe("doing");
  });

  test("ignores an older updatedAt", () => {
    patchTicket(qc, t("2", { status: "doing", updatedAt: 5 }));
    expect(pages()[0]!.items[1]!.status).toBe("todo");
    expect(qc.getQueryData<Get>(getKey("FRI-2"))!.ticket.status).toBe("todo");
  });

  test("removes a closed ticket from the list", () => {
    patchTicket(qc, t("3", { status: "closed", updatedAt: 20 }));
    expect(pages()[1]!.items).toEqual([]);
  });

  test("invalidates the list for an unknown ticket", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    patchTicket(qc, t("9"));
    expect(spy).toHaveBeenCalledWith({ queryKey: orpc.tickets.list.key() });
  });

  test("does not invalidate for an unknown closed ticket", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    patchTicket(qc, t("9", { status: "closed" }));
    expect(spy).not.toHaveBeenCalled();
  });
});
