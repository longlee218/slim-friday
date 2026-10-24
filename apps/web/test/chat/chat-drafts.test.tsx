import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { renderChat, setup, stubMatchMedia } from "./chat-view-fixtures";
import { msg } from "./fixtures";

vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { chat: { send: vi.fn(), uploadCreate: vi.fn() }, conversations: { markRead: vi.fn() } },
}));
vi.mock("@tanstack/react-virtual", () => import("./virtualizer-stub"));
beforeEach(stubMatchMedia);

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

test("the draft survives a switch away and back", async () => {
  const { router } = renderChat(setup([[msg({ id: 9 })]]));
  await userEvent.type(box(), "half a thought");
  await act(() => router.navigate("/c/group:crew"));
  expect(box().value).toBe("");
  await act(() => router.navigate("/c/bot:dev"));
  expect(box().value).toBe("half a thought");
});

test("draft and reply target survive unmounting the chat (width crossing)", async () => {
  const qc = setup([[msg({ id: 9, text: "Quote me" })]]);
  const first = renderChat(qc);
  await userEvent.type(box(), "still here");
  await userEvent.click(screen.getByRole("button", { name: "Reply to Dev" }));
  expect(screen.getByText("Quote me", { selector: ".reply-bar *" })).toBeTruthy();
  first.unmount();
  // Task 16 swaps the desktop shell for the phone shell: a fresh ChatView, same client.
  renderChat(qc);
  expect(box().value).toBe("still here");
  expect(screen.getAllByText("Quote me").length).toBeGreaterThan(1);
});
