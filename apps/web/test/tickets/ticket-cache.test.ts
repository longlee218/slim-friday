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

test("an older closed event never drops a newer cached ticket", () => {
  patchTicket(qc, t("1", { status: "closed", updatedAt: 5 }));
  expect(pages()[0]!.items.map((x) => x.id)).toEqual(["1", "2"]);
});

test("a filtered list is invalidated, not patched", () => {
  const todo = orpc.tickets.list.infiniteOptions({
    input: (cursor: string | undefined) => ({ cursor, status: "todo" as const }),
    initialPageParam: undefined,
    getNextPageParam: (p: Page) => p.nextCursor,
  });
  qc.setQueryData<InfiniteData<Page, string | undefined>>(todo.queryKey, {
    pages: [{ items: [t("1")] }],
    pageParams: [undefined],
  });
  const spy = vi.spyOn(qc, "invalidateQueries");
  patchTicket(qc, t("1", { status: "doing", updatedAt: 20 }));
  expect(qc.getQueryData<InfiniteData<Page>>(todo.queryKey)!.pages[0]!.items[0]!.status).toBe(
    "todo",
  );
  expect(spy).toHaveBeenCalledWith({ queryKey: todo.queryKey, exact: true });
  expect(pages()[0]!.items[0]!.status).toBe("doing");
});

describe("open ticket timeline (I1)", () => {
  test("a newer event invalidates the cached get of that ref", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    patchTicket(qc, t("2", { status: "review", updatedAt: 20, commentCount: 1 }));
    expect(qc.getQueryData<Get>(getKey("FRI-2"))!.ticket.status).toBe("review");
    expect(spy).toHaveBeenCalledWith({ queryKey: getKey("FRI-2"), exact: true });
  });

  test("an equal or older event does not invalidate the get", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    patchTicket(qc, t("2", { updatedAt: 10 }));
    patchTicket(qc, t("2", { updatedAt: 5 }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("unknown open ticket (I2)", () => {
  test("is inserted into page 1 by createdAt at once, and the list still refetches", () => {
    qc.setQueryData<InfiniteData<Page, string | undefined>>(listOptions.queryKey, {
      pages: [{ items: [t("5", { createdAt: 50 }), t("3", { createdAt: 30 })], nextCursor: "c" }],
      pageParams: [undefined],
    });
    const spy = vi.spyOn(qc, "invalidateQueries");
    patchTicket(qc, t("9", { createdAt: 90 }));
    patchTicket(qc, t("4", { createdAt: 40 }));
    expect(pages()[0]!.items.map((x) => x.id)).toEqual(["9", "5", "4", "3"]);
    expect(spy).toHaveBeenCalledWith({ queryKey: orpc.tickets.list.key() });
  });

  test("an older one past the end of a non-final page 1 is not inserted", () => {
    patchTicket(qc, t("0", { createdAt: 0 }));
    expect(pages()[0]!.items.map((x) => x.id)).toEqual(["1", "2"]);
  });

  test("a closed unknown ticket is never inserted", () => {
    patchTicket(qc, t("9", { status: "closed", createdAt: 90 }));
    expect(pages()[0]!.items.map((x) => x.id)).toEqual(["1", "2"]);
  });
});
