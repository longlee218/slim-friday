import type { FileLibraryItemDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { FilesRoute } from "../../src/components/files/files-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { bot, conv, group, seededClient } from "../shell/fixtures";

vi.mock("../../src/components/files/pdf-viewer", () => ({ default: () => null }));

const api = vi.hoisted(() => ({ files: vi.fn(), file: vi.fn() }));
vi.mock("../../src/api/client", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const empty = async () => [];
  const client = {
    chat: api,
    config: { bots: { list: empty }, groups: { list: empty } },
    conversations: { list: empty },
    tickets: { list: async () => ({ items: [] }) },
    control: { status: empty },
    approvals: { pending: empty },
    questions: { pending: empty },
  };
  return { client, orpc: createTanstackQueryUtils(client as never) };
});

const item = (id: string, conversationId: string): FileLibraryItemDto => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  kind: "image",
  size: 2048,
  conversationId,
  at: Date.now(),
});

beforeEach(() => {
  vi.resetAllMocks();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  window.innerWidth = 1200;
});

function renderFiles() {
  const client = seededClient({
    bots: [bot("dev", "Coder")],
    groups: [group("ops", "Ops team", ["dev"])],
    conversations: [conv("bot:dev", 0), conv("group:ops", 0)],
  });
  return render(
    <QueryClientProvider client={client}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/files"]}>
          <FilesRoute />
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
}

test("a row shows the bot or group name of its chat", async () => {
  api.files.mockResolvedValue({ items: [item("a", "bot:dev"), item("b", "group:ops")] });
  renderFiles();
  expect(await screen.findByText(/2 KB · PNG image · Coder/)).toBeTruthy();
  expect(screen.getByText(/2 KB · PNG image · Ops team/)).toBeTruthy();
});

test("a row of an unknown chat falls back to a neutral label", async () => {
  api.files.mockResolvedValue({ items: [item("a", "bot:")] });
  renderFiles();
  expect(await screen.findByText(/2 KB · PNG image · Chat/)).toBeTruthy();
});

test("picking a chat sends its conversationId from the first page", async () => {
  api.files.mockImplementation(async (input: { cursor?: string; conversationId?: string }) =>
    input.conversationId
      ? { items: [item("g", input.conversationId)] }
      : { items: [item("a", "bot:dev")], nextCursor: "c1" },
  );
  renderFiles();
  const user = userEvent.setup();
  await screen.findByText("a.png");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  await waitFor(() => expect(api.files.mock.calls.at(-1)?.[0].cursor).toBe("c1"));
  await user.selectOptions(screen.getByRole("combobox", { name: "Chat" }), "group:ops");
  expect(await screen.findByText("g.png")).toBeTruthy();
  const last = api.files.mock.calls.at(-1)?.[0];
  expect(last.conversationId).toBe("group:ops");
  expect(last.cursor).toBeUndefined();
  await user.selectOptions(screen.getByRole("combobox", { name: "Chat" }), "");
  expect((await screen.findAllByText("a.png")).length).toBeGreaterThan(0);
  expect((screen.getByRole("combobox", { name: "Chat" }) as HTMLSelectElement).value).toBe("");
});
