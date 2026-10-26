import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { setPending } from "../../src/components/chat/pending-sends";
import { applyEffects, resetStatusDebounce } from "../../src/events/apply-effects";
import { startRun } from "../../src/events/apply-runs";
import { approval } from "../shell/fixtures";
import { renderChat, setup, stubMatchMedia } from "./chat-view-fixtures";
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
vi.mock("@tanstack/react-virtual", () => import("./virtualizer-stub"));

beforeEach(() => {
  vi.clearAllMocks();
  stubMatchMedia();
  mocks.send.mockResolvedValue({ messageId: 50 });
  mocks.markRead.mockResolvedValue({ ok: true });
  mocks.stop.mockResolvedValue({ stopped: 1 });
});

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

test("no messages but an open approval shows the card, not the empty state", () => {
  const qc = setup([[]]);
  qc.setQueryData(orpc.approvals.pending.queryKey(), [approval("a1", "dev")]);
  renderChat(qc);
  expect(screen.getByText("Dev wants to use Bash")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Chat with Dev" })).toBeNull();
});

test("no messages but a live run shows the run, not the empty state", () => {
  const qc = setup([[]]);
  startRun(qc, "bot:dev", "dev", Date.now());
  renderChat(qc);
  expect(screen.queryByRole("heading", { name: "Chat with Dev" })).toBeNull();
});

test("an approval of another conversation keeps the empty state", () => {
  const qc = setup([[]]);
  qc.setQueryData(orpc.approvals.pending.queryKey(), [approval("a1", "pia")]);
  renderChat(qc);
  expect(screen.getByRole("heading", { name: "Chat with Dev" })).toBeTruthy();
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
  expect(within(container).getByText("Old news").closest(".msg")?.classList.contains("new")).toBe(
    false,
  );
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
