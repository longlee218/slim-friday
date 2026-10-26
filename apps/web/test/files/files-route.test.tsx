import type { FileLibraryItemDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { FilesRoute } from "../../src/components/files/files-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { seededClient } from "../shell/fixtures";

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

const item = (id: string, over: Partial<FileLibraryItemDto> = {}): FileLibraryItemDto => ({
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  kind: "image",
  size: 2048,
  conversationId: "bot:dev",
  at: Date.now(),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  window.innerWidth = 1200;
  api.file.mockResolvedValue({ url: "https://files.test/x" });
});

function renderFiles() {
  return render(
    <QueryClientProvider client={seededClient({})}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/files"]}>
          <FilesRoute />
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
}

test("an empty library says so", async () => {
  api.files.mockResolvedValue({ items: [] });
  renderFiles();
  expect(await screen.findByText("No files yet. Files you send in chat appear here.")).toBeTruthy();
});

test("rows show name, size and type", async () => {
  api.files.mockResolvedValue({
    items: [
      item("a", { name: "report.pdf", mimeType: "application/pdf", kind: "file", size: 3072 }),
    ],
  });
  renderFiles();
  expect(await screen.findByText("report.pdf")).toBeTruthy();
  expect(screen.getByText(/3 KB · PDF/)).toBeTruthy();
});

test("the chips change the kind sent", async () => {
  api.files.mockResolvedValue({ items: [] });
  renderFiles();
  const user = userEvent.setup();
  await waitFor(() => expect(api.files).toHaveBeenCalledTimes(1));
  expect(api.files.mock.calls[0]?.[0].kind).toBeUndefined();
  for (const [label, kind] of [
    ["Images", "image"],
    ["PDF", "pdf"],
    ["Other", "other"],
  ] as const) {
    await user.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(api.files.mock.calls.at(-1)?.[0].kind).toBe(kind));
  }
});

test("Load more requests the next cursor and appends", async () => {
  api.files.mockImplementation(async (input: { cursor?: string }) =>
    input.cursor
      ? { items: [item("b", { name: "b.png" })] }
      : { items: [item("a", { name: "a.png" })], nextCursor: "c1" },
  );
  renderFiles();
  const user = userEvent.setup();
  await screen.findByText("a.png");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("b.png")).toBeTruthy();
  expect(screen.getByText("a.png")).toBeTruthy();
  expect(api.files.mock.calls.at(-1)?.[0].cursor).toBe("c1");
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("a failed Load more keeps the rows and retries only the next page", async () => {
  let fail = true;
  api.files.mockImplementation(async (input: { cursor?: string }) => {
    if (!input.cursor) return { items: [item("a", { name: "a.png" })], nextCursor: "c1" };
    if (fail) throw new Error("boom");
    return { items: [item("b", { name: "b.png" })] };
  });
  renderFiles();
  const user = userEvent.setup();
  await screen.findByText("a.png");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Could not load more files.");
  expect(screen.getByText("a.png")).toBeTruthy();
  expect(screen.queryByText("Could not load your files.")).toBeNull();
  fail = false;
  api.files.mockClear();
  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("b.png")).toBeTruthy();
  expect(screen.getByText("a.png")).toBeTruthy();
  expect(api.files).toHaveBeenCalledTimes(1);
  expect(api.files.mock.calls[0]?.[0].cursor).toBe("c1");
});

test("changing the chip starts from the first page and marks it pressed", async () => {
  api.files.mockImplementation(async (input: { cursor?: string; kind?: string }) =>
    input.kind === "image"
      ? { items: [item("i", { name: "i.png" })] }
      : { items: [item("a", { name: "a.png" })], nextCursor: "c1" },
  );
  renderFiles();
  const user = userEvent.setup();
  await screen.findByText("a.png");
  expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(screen.getByRole("button", { name: "Images" }));
  expect(await screen.findByText("i.png")).toBeTruthy();
  expect(screen.queryByText("a.png")).toBeNull();
  const last = api.files.mock.calls.at(-1)?.[0];
  expect(last.kind).toBe("image");
  expect(last.cursor).toBeUndefined();
  expect(screen.getByRole("button", { name: "Images" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
});

test("a loading first page shows a loading note", async () => {
  api.files.mockReturnValue(new Promise(() => {}));
  renderFiles();
  expect(await screen.findByText("Loading…")).toBeTruthy();
});

test("a failed load shows an error and retries", async () => {
  api.files.mockRejectedValueOnce(new Error("boom"));
  api.files.mockResolvedValue({ items: [item("a", { name: "a.png" })] });
  renderFiles();
  const user = userEvent.setup();
  await screen.findByText("Could not load your files.");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("a.png")).toBeTruthy();
});

test("a PDF row opens the preview, not a download", async () => {
  api.files.mockResolvedValue({
    items: [item("p", { name: "p.pdf", mimeType: "application/pdf", kind: "file" })],
  });
  renderFiles();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await userEvent.setup().click(await screen.findByText("p.pdf"));
  expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("p.pdf", { selector: "b" })).toBeTruthy();
  expect(click).not.toHaveBeenCalled();
});

test("an image row opens the viewer", async () => {
  api.files.mockResolvedValue({ items: [item("a", { name: "a.png" })] });
  renderFiles();
  await userEvent.setup().click(await screen.findByText("a.png"));
  expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
});
