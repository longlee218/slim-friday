import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { PhoneActivityTab } from "../../src/components/activity/phone-activity-tab";

const api = vi.hoisted(() => ({ stop: vi.fn(), pending: vi.fn() }));
vi.mock("../../src/api/client", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const empty = async () => [];
  const client = {
    ops: {
      sessions: async () => [
        {
          botId: "dev",
          name: "Dev",
          working: true,
          label: "Running tests",
          tasks: [],
          spendToday: 1,
        },
      ],
      spend: async () => ({ rows: [], capPerBotPerDayUsd: 1.5 }),
      wakes: async () => [
        {
          id: "w-1",
          chainId: "c",
          conversationId: "bot:dev",
          targetBot: "dev",
          sender: { kind: "user" },
          intent: "request",
          hop: 0,
          status: "expired",
          attempts: 1,
          createdAt: 1,
        },
      ],
    },
    control: { stop: api.stop, status: empty },
    approvals: { pending: api.pending },
    config: { bots: { list: empty }, groups: { list: empty } },
    conversations: { list: empty },
  };
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

beforeEach(() => {
  vi.resetAllMocks();
});

function renderTab() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <PhoneActivityTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("lists working bots with Stop, the spend chart and recent wakes", async () => {
  api.stop.mockResolvedValue({ ok: true });
  api.pending.mockResolvedValue([]);
  renderTab();
  expect(await screen.findByText("Running tests")).toBeTruthy();
  expect(screen.getByText("No spend yet")).toBeTruthy();
  expect(await screen.findByText("expired")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(api.stop).toHaveBeenCalledWith({ botId: "dev" });
});

test("Waiting for you lists open approvals; a row opens the review sheet", async () => {
  api.pending.mockResolvedValue([
    {
      cardId: "a1",
      conversationId: "bot:dev",
      botId: "dev",
      botName: "Dev",
      tool: "Bash",
      scope: { command: "rm -rf dist" },
      summary: "Clean the build",
      input: "{}",
      inputCut: false,
      offerAlways: true,
    },
  ]);
  renderTab();
  expect(await screen.findByText("Waiting for you")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /rm -rf dist/ }));
  expect(await screen.findByRole("button", { name: "Allow once" })).toBeTruthy();
});
