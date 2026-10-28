import type { TicketDto, TicketTimelineItemDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { TicketPage } from "../../src/components/tickets/ticket-page";
import { bot, conv, seededClient } from "../shell/fixtures";
import { ticket } from "./fixtures";

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), comment: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));

// The Task 7 sample: one done box, one open box, and a box inside a fence (not a task).
const MD = "- [x] a\n```\n- [ ] code\n```\n- [ ] b";
const dev = { kind: "bot", botId: "dev" } as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

/** Shows the router's path so a test can see where the page navigated. */
const Path = () => <output data-testid="path">{useLocation().pathname}</output>;
const path = () => screen.getByTestId("path").textContent;

/** Renders the page for `ref` with Dev and one direct conversation in the directory cache. */
function renderPage(ref = "FRI-1") {
  const qc = seededClient({
    bots: [bot("dev", "Dev")],
    conversations: [{ ...conv("bot:dev", 0), title: "Dev chat" }],
  });
  return render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter>
          <Path />
          <TicketPage ticketRef={ref} />
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
}

const serve = (t: TicketDto, timeline: TicketTimelineItemDto[] = [], related: TicketDto[] = []) =>
  api.get.mockResolvedValue({ ticket: t, timeline, related });

test("an unknown ref shows the missing state", async () => {
  api.get.mockRejectedValue(Object.assign(new Error("nope"), { code: "NOT_FOUND" }));
  renderPage("FRI-9");
  expect(await screen.findByText("FRI-9 doesn't exist")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open the board" })).toBeTruthy();
});

test("progress counts real tasks only: 1 of 2 done", async () => {
  serve(ticket(1, { description: MD, assigneeBotId: "dev" }));
  renderPage();
  expect(await screen.findByText("1 of 2 done")).toBeTruthy();
});

test("no progress meter without task items", async () => {
  serve(ticket(1, { description: "plain text" }));
  renderPage();
  await screen.findByText("plain text");
  expect(screen.queryByText(/done$/)).toBeNull();
});

test("ticking the second box sends the toggled text with the cached updatedAt", async () => {
  const t = ticket(1, { description: MD, assigneeBotId: "dev" });
  serve(t);
  api.update.mockResolvedValue({ ...t, updatedAt: 11 });
  const { container } = renderPage();
  await screen.findByText("1 of 2 done");
  const boxes = container.querySelectorAll(".md .cb");
  // The fenced `- [ ]` renders as text, so only two boxes exist and the second is task 1.
  expect(boxes).toHaveLength(2);
  fireEvent.click(boxes[1] as Element);
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith({
      ref: "FRI-1",
      description: "- [x] a\n```\n- [ ] code\n```\n- [x] b",
      expectedUpdatedAt: 10,
    }),
  );
});

test("the timeline keeps the server order: event, comment card, event", async () => {
  serve(ticket(1, { assigneeBotId: "dev" }), [
    {
      type: "event",
      event: {
        id: "e1",
        ticketId: "1",
        kind: "created",
        to: "dev",
        actor: { kind: "user" },
        at: 1,
      },
    },
    {
      type: "comment",
      comment: { id: "c1", ticketId: "1", author: dev, body: "Started on it", createdAt: 2 },
    },
    {
      type: "event",
      event: { id: "e2", ticketId: "1", kind: "status", to: "doing", actor: dev, at: 3 },
    },
  ]);
  const { container } = renderPage();
  await screen.findByText("You created the ticket and assigned it to Dev");
  const rows = [...(container.querySelector(".tlog")?.children ?? [])];
  expect(rows.map((r) => r.className)).toEqual(["tev", "comment", "tev"]);
  expect(within(rows[1] as HTMLElement).getByText("Started on it")).toBeTruthy();
  expect(rows[2]?.textContent).toContain("Dev moved it to Doing");
});

test("side column names the conversation and lists related tickets", async () => {
  serve(ticket(1, { conversationId: "bot:dev", assigneeBotId: "dev" }), [], [ticket(2)]);
  renderPage();
  const link = await screen.findByText("Dev chat");
  expect(link.closest(".tlink")).toBeTruthy();
  expect(screen.getByText("Ticket 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Chat with Dev/ })).toBeTruthy();
  expect(screen.getByPlaceholderText("Comment. Dev is woken when you comment.")).toBeTruthy();
});

test("a box that maps to no counted task is disabled, not clickable", async () => {
  // An ordered-list task renders a box but is no counted task (task-list.ts counts bullets).
  serve(ticket(1, { description: "1. [ ] ordered\n- [ ] bullet" }));
  const { container } = renderPage();
  await screen.findByText("0 of 1 done");
  const [ordered, bullet] = [...container.querySelectorAll(".md .cb")];
  expect(ordered?.hasAttribute("data-chk")).toBe(false);
  expect(bullet?.hasAttribute("data-chk")).toBe(true);
  fireEvent.click(ordered as Element);
  expect(api.update).not.toHaveBeenCalled();
});

test("Close ticket leaves the page only after the close is saved", async () => {
  const t = ticket(1);
  serve(t);
  let finish: (v: unknown) => void = () => {};
  api.update.mockReturnValue(new Promise((r) => (finish = r)));
  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "Close ticket" }));
  await waitFor(() => expect(api.update).toHaveBeenCalled());
  expect(path()).toBe("/");
  expect(screen.getByRole("button", { name: "Close ticket" })).toBeTruthy();
  finish({ ...t, status: "closed", updatedAt: 11 });
  await waitFor(() => expect(path()).toBe("/tickets"));
});

test("a failed close keeps the page", async () => {
  serve(ticket(1));
  api.update.mockRejectedValue(new Error("boom"));
  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "Close ticket" }));
  await waitFor(() => expect(api.update).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(path()).toBe("/");
});

test("shows the note when woke is false, and clears it on the next input", async () => {
  serve(ticket(1));
  api.comment.mockResolvedValue({
    id: "c1",
    ticketId: "1",
    author: { kind: "user" },
    body: "late",
    createdAt: 3,
    woke: false,
    note: "No one was woken: the ticket is finished. Reopen it to continue.",
  });
  renderPage();
  const box = await screen.findByLabelText("Comment");
  await userEvent.type(box, "late");
  await userEvent.click(screen.getByRole("button", { name: "Comment" }));
  expect(await screen.findByText(/No one was woken: the ticket is finished/)).toBeTruthy();
  await userEvent.type(box, "x");
  expect(screen.queryByText(/No one was woken/)).toBeNull();
});
