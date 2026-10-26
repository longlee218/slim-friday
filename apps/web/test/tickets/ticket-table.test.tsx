import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TicketTable } from "../../src/components/tickets/ticket-table";
import { ticket } from "./fixtures";

vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi({}));

function renderTable(tickets: ReturnType<typeof ticket>[], selected: string | null = null) {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TicketTable tickets={tickets} selected={selected} onSelect={onSelect} onOpen={onOpen} />
    </QueryClientProvider>,
  );
  return { onSelect, onOpen };
}

test("the list shows title, ref, assignee and status per row and leaves closed tickets out", () => {
  renderTable([
    ticket(1, { title: "Ship it", status: "doing" }),
    ticket(2, { title: "Old one", status: "closed" }),
  ]);
  const row = screen.getByRole("button", { name: /Ship it/ });
  expect(row.textContent).toContain("FRI-1");
  expect(row.textContent).toContain("Unassigned");
  expect(row.textContent).toContain("Doing");
  expect(screen.queryByText("Old one")).toBeNull();
});

test("Enter on the selected row opens the page; on another row it selects", () => {
  const { onSelect, onOpen } = renderTable([ticket(1), ticket(2)], "FRI-1");
  fireEvent.keyDown(screen.getByRole("button", { name: /Ticket 1/ }), { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("FRI-1");
  fireEvent.keyDown(screen.getByRole("button", { name: /Ticket 2/ }), { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith("FRI-2");
});

test("with no open tickets the list says so", () => {
  renderTable([ticket(1, { status: "closed" })]);
  expect(screen.getByText("No open tickets.")).toBeTruthy();
});
