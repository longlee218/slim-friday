import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
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

/** Renders the page on a fresh client, which the test uses to trigger refetches. */
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PanelsContext.Provider value={{ toggle: () => {} } as never}>
          <ActivityPage />
        </PanelsContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

test("Stop calls control.stop and the row reads stopping; the limit meter turns amber at 50%", async () => {
  api.sessions.mockResolvedValue([dev(true)]);
  api.stop.mockResolvedValue({ ok: true });
  renderPage();
  expect(await screen.findByText("2h 14m")).toBeTruthy();
  expect(screen.getByText(/No spend in the last 7 days/)).toBeTruthy();
  expect(document.querySelector(".bars")).toBeNull();
  expect(screen.getByRole("img", { name: "Dev 50% of the daily limit" })).toBeTruthy();
  expect(document.querySelector(".meter i")?.getAttribute("style")).toContain("--amber-dot");
  await userEvent.click(screen.getByRole("button", { name: "Stop Dev" }));
  expect(api.stop).toHaveBeenCalledWith({ botId: "dev" });
  expect(await screen.findByText("stopping")).toBeTruthy();
});

test("a failed stop leaves the row working with its Stop button enabled", async () => {
  api.sessions.mockResolvedValue([dev(true)]);
  api.stop.mockRejectedValue(new Error("boom"));
  renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "Stop Dev" }));
  await waitFor(() => expect(api.stop).toHaveBeenCalled());
  expect(screen.queryByText("stopping")).toBeNull();
  expect(screen.getByText("working")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop Dev" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

test("stopping clears once the session refetch shows the bot idle", async () => {
  api.sessions.mockResolvedValue([dev(true)]);
  api.stop.mockResolvedValue({ ok: true });
  const qc = renderPage();
  await userEvent.click(await screen.findByRole("button", { name: "Stop Dev" }));
  expect(await screen.findByText("stopping")).toBeTruthy();
  api.sessions.mockResolvedValue([dev(false)]);
  await qc.invalidateQueries({ queryKey: orpc.ops.sessions.key() });
  expect(await screen.findByText("idle")).toBeTruthy();
  // A later session of the same bot is not "stopping".
  api.sessions.mockResolvedValue([dev(true)]);
  await qc.invalidateQueries({ queryKey: orpc.ops.sessions.key() });
  expect(await screen.findByText("working")).toBeTruthy();
  expect(screen.queryByText("stopping")).toBeNull();
});
