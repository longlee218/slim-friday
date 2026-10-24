import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { TicketLink } from "../../src/components/markdown/ticket-link";
import { bot, seededClient } from "../shell/fixtures";
import { ticket } from "./fixtures";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));

/** Stubs `matchMedia`; `noHover` answers the `(hover: none)` query. */
function media(noHover: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: noHover && q.includes("hover: none"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const renderLink = () =>
  render(
    <QueryClientProvider client={seededClient({ bots: [bot("dev", "Dev")] })}>
      <MemoryRouter>
        <TicketLink ticketRef="FRI-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.resetAllMocks();
  media(false);
});

test("the card fetches nothing until it opens, then shows title and status", async () => {
  api.get.mockResolvedValue({
    ticket: ticket(1, { title: "Export CSV", status: "doing", assigneeBotId: "dev" }),
    timeline: [],
    related: [],
  });
  renderLink();
  expect(api.get).not.toHaveBeenCalled();
  await userEvent.hover(screen.getByText("FRI-1"));
  expect(await screen.findByText("Export CSV", {}, { timeout: 2000 })).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Doing")).toBeTruthy();
});

test("a missing ticket says so", async () => {
  api.get.mockRejectedValue(Object.assign(new Error("x"), { code: "NOT_FOUND" }));
  renderLink();
  await userEvent.hover(screen.getByText("FRI-1"));
  expect(await screen.findByText("Ticket not found", {}, { timeout: 2000 })).toBeTruthy();
});

test("without hover (touch) the link stays plain and never fetches", async () => {
  media(true);
  renderLink();
  await userEvent.hover(screen.getByText("FRI-1"));
  await new Promise((r) => setTimeout(r, 500));
  expect(api.get).not.toHaveBeenCalled();
});
