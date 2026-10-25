import type { BotDto, McpServerDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../../src/api/client";
import { McpDetail } from "../../../src/components/settings/mcp/mcp-detail";
import { bot, seededClient } from "../../shell/fixtures";

const api = vi.hoisted(() => ({
  test: vi.fn(),
  save: vi.fn(),
  del: vi.fn(),
  botGet: vi.fn(),
  botSave: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../../src/api/client")>()),
  client: {
    config: {
      mcp: { test: api.test, save: api.save, delete: api.del },
      bots: { get: api.botGet, save: api.botSave },
    },
  },
}));

const github: McpServerDto = {
  type: "http",
  name: "github",
  url: "https://api.example.com/mcp",
  headers: { Authorization: "${GITHUB_TOKEN}" },
  shipped: false,
  usedBy: [],
};

function setup(server: McpServerDto = github, bots: BotDto[] = [bot("dev", "Dev")]) {
  const qc = seededClient({ bots });
  qc.setQueryData(orpc.config.mcp.list.queryKey(), [server]);
  qc.setQueryData(orpc.config.mcp.calls.queryKey({ input: { server: server.name, limit: 20 } }), [
    { at: 1000, botId: "dev", tool: "mcp__github__old", outcome: "allow" },
    { at: 3000, botId: "dev", tool: "mcp__github__new", outcome: "deny" },
  ]);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/settings/mcp/${server.name}`]}>
        <Routes>
          <Route path="/settings/mcp/:name" element={<McpDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.test.mockResolvedValue({ state: "connected", tools: ["a"] });
  api.botSave.mockResolvedValue({});
  api.botGet.mockResolvedValue({ ...bot("dev", "Dev"), tools: ["Read"] });
});

test("tests the server on open and shows the status", async () => {
  setup();
  expect(await screen.findByText(/Connected/)).toBeTruthy();
  expect(api.test).toHaveBeenCalledWith({
    name: "github",
    server: {
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "${GITHUB_TOKEN}" },
    },
  });
});

test("a failed test shows the error and Retry", async () => {
  api.test.mockResolvedValue({ state: "error", message: "needs GITHUB_TOKEN" });
  setup();
  expect(await screen.findByText("needs GITHUB_TOKEN")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("the Used by switch saves the bot's fresh tools plus mcp__github", async () => {
  setup();
  await userEvent.click(await screen.findByRole("switch", { name: "Dev uses github" }));
  await waitFor(() => expect(api.botSave).toHaveBeenCalled());
  // Built from the bot fetched at click time (tools: Read), not from the cached list.
  expect(api.botGet).toHaveBeenCalledWith({ id: "dev" });
  const input = api.botSave.mock.calls[0]?.[0];
  expect(input.mode).toBe("update");
  expect(input.id).toBe("dev");
  expect(input.bot.tools).toEqual(["Read", "mcp__github"]);
});

test("a shipped bot's switch is disabled", async () => {
  setup(github, [{ ...bot("dev", "Dev"), shipped: true }]);
  const sw = (await screen.findByRole("switch", { name: "Dev uses github" })) as HTMLButtonElement;
  expect(sw.disabled).toBe(true);
});

test("recent calls list the newest first", async () => {
  setup();
  const rows = await screen.findAllByText(/mcp__github__/);
  expect(rows.map((r) => r.textContent)).toEqual(["mcp__github__new", "mcp__github__old"]);
  const row = rows[0]?.closest(".srow") as HTMLElement;
  expect(within(row).getByText("denied")).toBeTruthy();
});

test("a shipped server is read only", async () => {
  setup({ ...github, shipped: true });
  await screen.findByText(/Connected/);
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect((screen.getByLabelText("URL") as HTMLInputElement).disabled).toBe(true);
});

test("Remove shows the server's refusal", async () => {
  api.del.mockRejectedValue({ code: "CONFLICT", message: "Used by dev" });
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(api.del).toHaveBeenCalledWith({ name: "github" }));
});

test("on the phone (no page head) a Remove row removes the server", async () => {
  const width = window.innerWidth;
  window.innerWidth = 390;
  try {
    api.del.mockResolvedValue({ ok: true });
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Remove this server" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith({ name: "github" }));
  } finally {
    window.innerWidth = width;
  }
});
