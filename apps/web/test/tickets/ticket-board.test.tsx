import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TicketBoard } from "../../src/components/tickets/ticket-board";
import { groupByStatus, useAllTickets } from "../../src/components/tickets/use-tickets";
import { ticket } from "./fixtures";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi({ list }));

test("groupByStatus puts each status in its column and drops closed", () => {
  const g = groupByStatus([
    ticket(1, { status: "todo" }),
    ticket(2, { status: "review" }),
    ticket(3, { status: "closed" }),
    ticket(4, { status: "blocked" }),
  ]);
  expect(g.todo.map((t) => t.ref)).toEqual(["FRI-1"]);
  expect(g.review.map((t) => t.ref)).toEqual(["FRI-2"]);
  expect(g.blocked.map((t) => t.ref)).toEqual(["FRI-4"]);
  expect(g.doing).toEqual([]);
  expect(Object.values(g).flat().length).toBe(3);
});

/** Loads every page through `useAllTickets` and shows them on the board. */
function Harness() {
  const { tickets } = useAllTickets();
  return <TicketBoard tickets={tickets} selected={null} onSelect={() => {}} onOpen={() => {}} />;
}

test("the board loads every page of 120 tickets and counts them", async () => {
  const all = Array.from({ length: 120 }, (_, i) => ticket(i + 1));
  list.mockImplementation(async ({ cursor }: { cursor?: string }) => {
    if (cursor === undefined) return { items: all.slice(0, 50), nextCursor: "c1" };
    if (cursor === "c1") return { items: all.slice(50, 100), nextCursor: "c2" };
    return { items: all.slice(100) };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
  await waitFor(
    () => {
      const head = screen.getByText("To do").closest(".col-h") as HTMLElement;
      expect(within(head).getByText("120")).toBeTruthy();
    },
    { timeout: 8000 },
  );
  expect(list).toHaveBeenCalledTimes(3);
  expect(list.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1", "c2"]);
});
