import type { ConversationDto, MessageDto } from "@friday/contracts";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { ChatView } from "../../src/components/chat/chat-view";
import { setPending } from "../../src/components/chat/pending-sends";
import { AppShell } from "../../src/components/shell/app-shell";
import { applyEffects, resetStatusDebounce } from "../../src/events/apply-effects";
import { messagesKey } from "../../src/events/apply-messages";
import { bot, conv, group, seededClient, status } from "../shell/fixtures";
import { msg } from "./fixtures";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  markRead: vi.fn(),
  stop: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: {
    chat: { send: mocks.send, uploadCreate: vi.fn() },
    conversations: { markRead: mocks.markRead },
    control: { stop: mocks.stop },
  },
}));
// jsdom cannot measure layout, so the real virtualizer would render no rows. This stand-in
// renders every item; the real one is covered by the browser build. Pure logic (items,
// anchoring, swipe) has its own unit tests.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (i: number) => string | number;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 100,
        size: 100,
      })),
    getTotalSize: () => count * 100,
    measureElement: () => {},
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  mocks.send.mockResolvedValue({ messageId: 50 });
  mocks.markRead.mockResolvedValue({ ok: true });
  mocks.stop.mockResolvedValue({ stopped: 1 });
});
afterEach(() => vi.useRealTimers());

const devConv: ConversationDto = { ...conv("bot:dev", 3), botId: "dev", title: "Dev" };
const crewConv: ConversationDto = { ...conv("group:crew", 0), groupId: "crew", title: "Crew" };

/** A client with Dev, Pia and a Crew group; `pages` seeds the Dev transcript. */
function setup(pages: MessageDto[][]): QueryClient {
  const qc = seededClient({
    bots: [{ ...bot("dev", "Dev"), title: "Developer" }, bot("pia", "Pia")],
    groups: [group("crew", "Crew", ["pia", "dev"])],
    conversations: [devConv, crewConv],
    status: [status("dev", "Dev", false), status("pia", "Pia", true, "Writing")],
  });
  qc.setQueryData(messagesKey("bot:dev"), { pages, pageParams: pages.map(() => undefined) });
  qc.setQueryData(messagesKey("group:crew"), { pages: [[]], pageParams: [undefined] });
  return qc;
}

function renderChat(qc: QueryClient, path = "/c/bot:dev") {
  const router = createMemoryRouter(
    [
      {
        path: "/c/:conversationId",
        element: <AppShell sidebar={<nav>side</nav>} main={<ChatView />} />,
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("chat view shows the empty state with suggestions", async () => {
  renderChat(setup([[]]));
  expect(screen.getByRole("heading", { name: "Chat with Dev" })).toBeTruthy();
  expect(screen.getByText("Developer")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Summarise yesterday" }));
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
    "Summarise yesterday",
  );
});

test("a group's empty state names the entry bot", () => {
  renderChat(setup([[]]), "/c/group:crew");
  expect(screen.getByRole("heading", { name: "Crew", level: 3 })).toBeTruthy();
  expect(screen.getByText("Messages go to Pia unless you @name a member.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Who is blocked?" })).toBeTruthy();
  // Group toolbar: member count and how many work.
  expect(screen.getByText("2 members · 1 working")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop the group" })).toBeTruthy();
});

test("an unknown conversation says so", () => {
  renderChat(setup([[]]), "/c/bot:nobody");
  expect(screen.getByText("This conversation doesn't exist.")).toBeTruthy();
});

test("history renders oldest first and is not animated", () => {
  const { container } = renderChat(
    setup([[msg({ id: 9, text: "Newer" }), msg({ id: 8, text: "Older" })]]),
  );
  const texts = [...container.querySelectorAll(".msg .body")].map((e) =>
    e.textContent?.includes("Older") ? "Older" : "Newer",
  );
  expect(texts).toEqual(["Older", "Newer"]);
  expect(container.querySelector(".msg.new")).toBeNull();
});

test("an appendMessage effect shows up in the transcript and animates in", async () => {
  const qc = setup([[msg({ id: 9, text: "Old news" })]]);
  const { container } = renderChat(qc);
  act(() =>
    applyEffects(
      qc,
      [{ op: "appendMessage", message: msg({ id: 10, text: "Fresh news" }) }],
      () => {},
    ),
  );
  const fresh = await screen.findByText("Fresh news");
  expect(fresh.closest(".msg")?.classList.contains("new")).toBe(true);
  expect(within(container).getByText("Old news").closest(".msg")?.className).toBe("msg");
});

test("mark read after the newest message is seen", async () => {
  vi.useFakeTimers();
  const qc = setup([[msg({ id: 9 }), msg({ id: 8 })]]);
  renderChat(qc);
  expect(mocks.markRead).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(mocks.markRead).toHaveBeenCalledWith({ id: "bot:dev", messageId: 9 });
  await act(async () => {});
  // The badge goes to 0 locally through the setUnread effect.
  const list = qc.getQueryData<ConversationDto[]>(orpc.conversations.list.queryKey());
  expect(list?.find((c) => c.id === "bot:dev")?.unread).toBe(0);
});

test("stop calls control.stop with the conversation", async () => {
  const qc = setup([[msg({ id: 9 })]]);
  renderChat(qc);
  await userEvent.click(screen.getByRole("button", { name: "Stop Dev" }));
  await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith({ conversationId: "bot:dev" }));
  expect(mocks.toast).toHaveBeenCalledWith("Stopped. Background tasks were cancelled.");
  resetStatusDebounce(qc);
});

test("a failed send shows Retry and resends the same payload", async () => {
  const qc = setup([[msg({ id: -1, author: { kind: "user" }, text: "ship it" })]]);
  setPending(qc, -1, {
    state: "failed",
    payload: { conversationId: "bot:dev", text: "ship it" },
    route: { botIds: ["dev"], reason: "direct" },
  });
  renderChat(qc);
  expect(screen.getByText("ship it")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.send).toHaveBeenCalledWith({ conversationId: "bot:dev", text: "ship it" });
});

test("files dropped on the transcript reach the composer", async () => {
  const { container } = renderChat(setup([[msg({ id: 9 })]]));
  const big = new File([new Uint8Array(21 * 1024 * 1024)], "big.bin");
  fireEvent.drop(container.querySelector(".content") as HTMLElement, {
    dataTransfer: { files: [big] },
  });
  // The composer refuses the 21 MB file before any network call and says so.
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(String(mocks.toast.mock.calls[0]?.[0])).toMatch(/20 MB/);
});

test("the draft survives a switch away and back", async () => {
  const qc = setup([[msg({ id: 9 })]]);
  const router = createMemoryRouter(
    [{ path: "/c/:conversationId", element: <AppShell sidebar={null} main={<ChatView />} /> }],
    { initialEntries: ["/c/bot:dev"] },
  );
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await userEvent.type(screen.getByLabelText("Message"), "half a thought");
  await act(() => router.navigate("/c/group:crew"));
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  await act(() => router.navigate("/c/bot:dev"));
  expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half a thought");
});
