import { screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { messagesKey } from "../../src/events/apply-messages";
import { phoneClient, renderPhone, stubMatchMedia } from "./phone-fixtures";

const { markRead } = vi.hoisted(() => ({ markRead: vi.fn() }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { conversations: { markRead }, chat: { send: vi.fn(), uploadCreate: vi.fn() } },
}));
vi.mock("@tanstack/react-virtual", () => import("../chat/virtualizer-stub"));

beforeEach(() => {
  stubMatchMedia();
  window.innerWidth = 390;
  markRead.mockResolvedValue({ ok: true });
});

test("a phone chat with no messages but an open approval shows the approval row", () => {
  const qc = phoneClient();
  qc.setQueryData(messagesKey("bot:dev"), { pages: [[]], pageParams: [undefined] });
  renderPhone(qc, "/c/bot:dev");
  expect(screen.getByText("Dev wants to use Bash")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
});
