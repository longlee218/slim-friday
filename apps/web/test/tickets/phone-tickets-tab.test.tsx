import type { TicketStatus } from "@friday/contracts";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { NewTicketContext } from "../../src/app/shell-context";
import { PhoneTicketsTab, phoneSegment } from "../../src/components/tickets/phone-tickets-tab";
import { ticketListOptions } from "../../src/components/tickets/use-tickets";
import { phoneClient, renderPhone, stubMatchMedia } from "../phone/phone-fixtures";
import { bot, seededClient } from "../shell/fixtures";
import { ticket } from "./fixtures";

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), comment: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));

const TICKETS = [
  ticket(1, { status: "todo", title: "Write the intro" }),
  ticket(2, { status: "doing", title: "Fix the build", assigneeBotId: "dev" }),
  ticket(3, { status: "blocked", title: "Wait for keys", blockedReason: "No access" }),
  ticket(4, { status: "review", title: "Review the plan" }),
  ticket(5, { status: "done", title: "Ship v1" }),
];

beforeEach(() => {
  vi.resetAllMocks();
  stubMatchMedia();
  window.innerWidth = 390;
});

test("phoneSegment maps the six statuses", () => {
  const seg = (status: TicketStatus) => phoneSegment(ticket(1, { status }));
  expect(seg("todo")).toBe("open");
  expect(seg("doing")).toBe("open");
  expect(seg("blocked")).toBe("open");
  expect(seg("review")).toBe("review");
  expect(seg("done")).toBe("done");
  expect(seg("closed")).toBeNull();
});

/** Seeds the board list (the seeded client never fetches). */
const withTickets = <T extends QueryClient>(qc: T): T => {
  qc.setQueryData(ticketListOptions.queryKey, {
    pages: [{ items: TICKETS }],
    pageParams: [undefined],
  });
  return qc;
};

function renderTab(openNew = () => {}) {
  const qc = withTickets(seededClient({ bots: [bot("dev", "Dev")] }));
  return render(
    <QueryClientProvider client={qc}>
      <NewTicketContext.Provider value={openNew}>
        <MemoryRouter>
          <PhoneTicketsTab />
        </MemoryRouter>
      </NewTicketContext.Provider>
    </QueryClientProvider>,
  );
}

test("Open lists To do, Doing and Blocked sections only", async () => {
  renderTab();
  expect(await screen.findByText("Write the intro")).toBeTruthy();
  for (const h of ["To do", "Doing", "Blocked"]) expect(screen.getByText(h)).toBeTruthy();
  expect(screen.queryByText("Review the plan")).toBeNull();
  expect(screen.queryByText("Ship v1")).toBeNull();
});

test("switching to To review shows only review tickets", async () => {
  renderTab();
  await screen.findByText("Write the intro");
  await userEvent.click(screen.getByRole("button", { name: "To review" }));
  expect(screen.getByText("Review the plan")).toBeTruthy();
  expect(screen.queryByText("Write the intro")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Ship v1")).toBeTruthy();
});

test("the plus button opens the new ticket sheet", async () => {
  const openNew = vi.fn();
  renderTab(openNew);
  await userEvent.click(screen.getByRole("button", { name: "New ticket" }));
  expect(openNew).toHaveBeenCalled();
});

test("a row pushes the ticket view, whose back reads Tickets", async () => {
  const { router } = renderPhone(withTickets(phoneClient()), "/tickets");
  await userEvent.click(await screen.findByText("Fix the build"));
  expect(router.state.location.pathname).toBe("/tickets/FRI-2");
  api.get.mockResolvedValue({ ticket: TICKETS[1], timeline: [], related: [] });
  const nav = document.querySelector(".ios-nav.solid .back")?.closest(".ios-nav") as HTMLElement;
  expect(await within(nav).findByRole("button", { name: "Tickets" })).toBeTruthy();
});

test("the status bottom sheet saves the picked status", async () => {
  const t = TICKETS[0] as (typeof TICKETS)[number];
  api.get.mockResolvedValue({ ticket: t, timeline: [], related: [] });
  api.update.mockResolvedValue({ ...t, status: "review", updatedAt: 11 });
  renderPhone(withTickets(phoneClient()), "/tickets/FRI-1");
  await userEvent.click(await screen.findByRole("button", { name: "Status" }));
  const sheet = await screen.findByRole("dialog");
  await userEvent.click(within(sheet).getByText("Review"));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith({
      ref: "FRI-1",
      status: "review",
      expectedUpdatedAt: 10,
    }),
  );
});

test("Close ticket saves closed and leaves the view", async () => {
  const t = TICKETS[0] as (typeof TICKETS)[number];
  api.get.mockResolvedValue({ ticket: t, timeline: [], related: [] });
  api.update.mockResolvedValue({ ...t, status: "closed", updatedAt: 11 });
  const { router } = renderPhone(withTickets(phoneClient()), "/tickets/FRI-1");
  await userEvent.click(await screen.findByText("Close ticket"));
  await waitFor(() => expect(router.state.location.pathname).toBe("/tickets"));
  expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
});

test("the comment box posts a comment", async () => {
  const t = TICKETS[0] as (typeof TICKETS)[number];
  api.get.mockResolvedValue({ ticket: t, timeline: [], related: [] });
  api.comment.mockResolvedValue({});
  renderPhone(withTickets(phoneClient()), "/tickets/FRI-1");
  await userEvent.type(await screen.findByLabelText("Comment"), "hello");
  await userEvent.click(screen.getByRole("button", { name: "Send comment" }));
  await waitFor(() => expect(api.comment).toHaveBeenCalledWith({ ref: "FRI-1", text: "hello" }));
});

test("Blocked on the phone asks why, then saves status and reason", async () => {
  const t = TICKETS[0] as (typeof TICKETS)[number];
  api.get.mockResolvedValue({ ticket: t, timeline: [], related: [] });
  api.update.mockResolvedValue({
    ...t,
    status: "blocked",
    blockedReason: "No keys",
    updatedAt: 11,
  });
  renderPhone(withTickets(phoneClient()), "/tickets/FRI-1");
  await userEvent.click(await screen.findByRole("button", { name: "Status" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByText("Blocked"));
  expect(api.update).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("Why blocked?"), "No keys");
  await userEvent.click(screen.getByRole("button", { name: "Block" }));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith({
      ref: "FRI-1",
      status: "blocked",
      blockedReason: "No keys",
      expectedUpdatedAt: 10,
    }),
  );
});
