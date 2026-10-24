import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { ActivityPage } from "../../src/components/activity/activity-page";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";

const api = vi.hoisted(() => ({ stop: vi.fn(), sessions: vi.fn(), spend: vi.fn() }));
vi.mock("../../src/api/client", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const empty = async () => [];
  const client = {
    ops: { sessions: api.sessions, spend: api.spend, wakes: empty },
    control: { stop: api.stop, status: empty },
    config: { bots: { list: empty }, groups: { list: empty } },
    conversations: { list: empty },
  };
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

const dev = (working: boolean) => ({
  botId: "dev",
  name: "Dev",
  working,
  label: "Running tests",
  tasks: [],
  spendToday: 0.75,
  startedAt: Date.now() - 8_040_000,
});

beforeEach(() => {
  vi.resetAllMocks();
  // jsdom has no matchMedia (the toolbar reads it).
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  api.spend.mockResolvedValue({ rows: [], capPerBotPerDayUsd: 1.5 });
});

test("Stop calls control.stop and the row reads stopping; the limit meter turns amber at 50%", async () => {
  api.sessions.mockResolvedValue([dev(true)]);
  api.stop.mockResolvedValue({ ok: true });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <PanelsContext.Provider value={{ toggle: () => {} } as never}>
          <ActivityPage />
        </PanelsContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("2h 14m")).toBeTruthy();
  expect(screen.getByText("No spend yet")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Dev 50% of the daily limit" })).toBeTruthy();
  expect(document.querySelector(".meter i")?.getAttribute("style")).toContain("--amber-dot");
  await userEvent.click(screen.getByRole("button", { name: "Stop Dev" }));
  expect(api.stop).toHaveBeenCalledWith({ botId: "dev" });
  expect(await screen.findByText("stopping")).toBeTruthy();
});
