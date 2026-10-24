import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { TicketPageRoute } from "../../src/components/tickets/ticket-page-route";
import { useSelectedTicket } from "../../src/components/tickets/use-ticket-selection";
import { seededClient } from "../shell/fixtures";
import { ticket } from "./fixtures";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

/** Shows the drawer ref the URL selects. */
const Selected = () => <output data-testid="sel">{useSelectedTicket()}</output>;

test("/tickets/fri-3 loads the canonical FRI-3 (cache key matches live patches)", async () => {
  api.get.mockResolvedValue({ ticket: ticket(3), timeline: [], related: [] });
  render(
    <QueryClientProvider client={seededClient({})}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/tickets/fri-3"]}>
          <Routes>
            <Route path="/tickets/:ref" element={<TicketPageRoute />} />
          </Routes>
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(api.get.mock.calls[0]![0]).toEqual({ ref: "FRI-3" });
});

test("?t=fri-3 selects FRI-3", () => {
  render(
    <MemoryRouter initialEntries={["/tickets?t=fri-3"]}>
      <Selected />
    </MemoryRouter>,
  );
  expect(screen.getByTestId("sel").textContent).toBe("FRI-3");
});
