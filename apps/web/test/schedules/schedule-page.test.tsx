import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { run } from "./fixtures";
import { button, desktopMedia, field, news, path, renderPage } from "./page-harness";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  runs: vi.fn(),
  delete: vi.fn(),
  runNow: vi.fn(),
  setEnabled: vi.fn(),
}));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  vi.resetAllMocks();
  api.runs.mockResolvedValue({ items: [] });
  vi.stubGlobal("matchMedia", desktopMedia);
});

/** Renders the page serving `news(over)` and waits for the form. */
async function open(over: Parameters<typeof news>[0] = {}) {
  api.get.mockResolvedValue({ schedule: news(over) });
  renderPage();
  await screen.findByDisplayValue("Morning news");
}

test("the header says when, where and next; bot and Post to are read-only", async () => {
  await open({ when: "Every day 07:30 (Asia/Ho_Chi_Minh)", conversationId: "group:crew" });
  expect(screen.getByText(/Every day 07:30 \(Asia\/Ho_Chi_Minh\) · posts to Crew · next/));
  expect(screen.queryByRole("combobox", { name: "Bot" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Post to" })).toBeNull();
});

test("Delete asks with the exact copy, deletes and returns to the list without not-found", async () => {
  api.delete.mockResolvedValue({});
  await open();
  await userEvent.click(button("Delete"));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Delete Morning news?")).toBeTruthy();
  expect(
    within(sheet).getByText("Its run history goes too. Messages it posted stay in the chat."),
  ).toBeTruthy();
  api.get.mockRejectedValue({ code: "NOT_FOUND", message: "not found" });
  await userEvent.click(within(sheet).getByRole("button", { name: "Delete schedule" }));
  await waitFor(() => expect(path()).toBe("/schedules"));
  expect(api.delete).toHaveBeenCalledWith({ id: "a" });
  expect(screen.queryByText(/does not exist/)).toBeNull();
});

test("a missing schedule and a failed load say different things", async () => {
  api.get.mockRejectedValue({ code: "NOT_FOUND", message: "x" });
  const { unmount } = renderPage();
  expect(await screen.findByText("This schedule does not exist.")).toBeTruthy();
  unmount();
  api.get.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR", message: "x" });
  renderPage();
  expect(await screen.findByText("Could not load the schedule.")).toBeTruthy();
});

test("a schedule whose bot is gone is read-only except Delete, with the reason", async () => {
  await open({ enabled: false, disabledReason: "bot_gone" });
  expect(screen.getByText(/bot is gone/i)).toBeTruthy();
  expect(field("Name").disabled).toBe(true);
  expect(field("Task").disabled).toBe(true);
  expect(button("Delete").disabled).toBe(false);
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
});

test("Run now while a run is going says Still running with a link to the chat", async () => {
  api.runNow.mockRejectedValue({ code: "CONFLICT", message: "busy" });
  await open();
  await userEvent.click(button("Run now"));
  const note = (await screen.findByText(/Still running/)) as HTMLElement;
  expect(within(note).getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe(
    "/c/bot:ray",
  );
  expect(path()).toBe("/schedules/a");
});

test("recent runs open the result message's chat and load more by nextBefore", async () => {
  api.runs
    .mockResolvedValueOnce({ items: [{ ...run("ok"), messageId: 7, firedAt: 50 }], nextBefore: 50 })
    .mockResolvedValueOnce({ items: [{ ...run("failed"), id: "r2", error: "Timed out" }] });
  await open();
  const ok = await screen.findByText("OK", { selector: ".sched-runs .pill" });
  expect(ok.closest("a")?.getAttribute("href")).toBe("/c/bot:ray");
  await userEvent.click(button("Load more"));
  expect(await screen.findByText("Timed out")).toBeTruthy();
  expect(api.runs).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "a", before: 50 }),
    expect.anything(),
  );
});
