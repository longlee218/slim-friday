import type { ConversationDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { useMarkRead } from "../../src/components/chat/use-mark-read";
import { conv, seededClient } from "../shell/fixtures";
import { renderChat, setup, stubMatchMedia } from "./chat-view-fixtures";
import { msg } from "./fixtures";

const markRead = vi.hoisted(() => vi.fn());
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { chat: { send: vi.fn(), uploadCreate: vi.fn() }, conversations: { markRead } },
}));
vi.mock("@tanstack/react-virtual", () => import("./virtualizer-stub"));

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia();
  markRead.mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

test("mark read after the newest message is seen", async () => {
  vi.useFakeTimers();
  const qc = setup([[msg({ id: 9 }), msg({ id: 8 })]]);
  renderChat(qc);
  expect(markRead).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(markRead).toHaveBeenCalledWith({ id: "bot:dev", messageId: 9 });
  await act(async () => {});
  // The badge goes to 0 locally through the setUnread effect.
  const list = qc.getQueryData<ConversationDto[]>(orpc.conversations.list.queryKey());
  expect(list?.find((c) => c.id === "bot:dev")?.unread).toBe(0);
});

function Probe({ id, atBottom }: { id: number; atBottom: boolean }) {
  useMarkRead("bot:dev", id, atBottom);
  return <i>probe</i>;
}

test("the same id is never sent twice", async () => {
  vi.useFakeTimers();
  const qc = seededClient({ conversations: [conv("bot:dev", 1)] });
  const ui = (id: number, atBottom: boolean) => (
    <QueryClientProvider client={qc}>
      <Probe id={id} atBottom={atBottom} />
    </QueryClientProvider>
  );
  const { rerender } = render(ui(9, true));
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(markRead).toHaveBeenCalledTimes(1);
  // Leaving the bottom and coming back with the same newest id sends nothing.
  rerender(ui(9, false));
  rerender(ui(9, true));
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(markRead).toHaveBeenCalledTimes(1);
  // A newer id is sent.
  rerender(ui(10, true));
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith({ id: "bot:dev", messageId: 10 });
  expect(screen.getByText("probe")).toBeTruthy();
});
