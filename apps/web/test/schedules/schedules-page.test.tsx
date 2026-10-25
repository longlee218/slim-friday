import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { run, schedule } from "./fixtures";
import { path, renderList, row, runNowIn } from "./list-harness";

const api = vi.hoisted(() => ({ list: vi.fn(), runNow: vi.fn(), setEnabled: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

const renderPage = (items: Parameters<typeof renderList>[1]) => renderList(api.list, items);

test("rows show the last-result pills from the brief's map", async () => {
  renderPage([
    schedule("a", { name: "A", last: run("ok") }),
    schedule("b", { name: "B", last: run("problem") }),
    schedule("c", { name: "C", last: run("failed") }),
  ]);
  expect(within(await row("A")).getByText("OK")).toBeTruthy();
  expect(within(await row("B")).getByText("Found a problem")).toBeTruthy();
  expect(within(await row("C")).getByText("Failed")).toBeTruthy();
});

test("a paused row says Paused and has Run now disabled", async () => {
  renderPage([schedule("a", { name: "A", enabled: false, last: run("ok") })]);
  const r = await row("A");
  expect(within(r).getAllByText("Paused").length).toBeGreaterThan(0);
  expect(runNowIn(r).disabled).toBe(true);
});

test("a bot_gone row renders without the bot, says Bot is gone and locks the switch", async () => {
  renderPage([
    schedule("a", {
      name: "A",
      botId: "ghost",
      conversationId: "bot:ghost",
      enabled: false,
      disabledReason: "bot_gone",
    }),
  ]);
  const r = await row("A");
  expect(within(r).getByText("Bot is gone")).toBeTruthy();
  expect(within(r).getByText("ghost · own chat")).toBeTruthy();
  expect((within(r).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
});

test("the subtitle names the own chat or the target group", async () => {
  renderPage([
    schedule("a", { name: "A" }),
    schedule("b", { name: "B", conversationId: "group:crew" }),
    schedule("c", { name: "C", conversationId: "group:gone" }),
  ]);
  expect(within(await row("A")).getByText("Ray · own chat")).toBeTruthy();
  expect(within(await row("B")).getByText("Ray → Crew")).toBeTruthy();
  expect(within(await row("C")).getByText("Ray → gone")).toBeTruthy();
});

test("an on row shows when and the next run in the schedule's time zone", async () => {
  renderPage([
    schedule("a", {
      name: "A",
      timeZone: "Asia/Ho_Chi_Minh",
      nextRunAt: Date.UTC(2030, 0, 15, 0, 30),
    }),
  ]);
  const r = await row("A");
  expect(within(r).getByText("Every day 07:30 (Asia/Ho_Chi_Minh)")).toBeTruthy();
  expect(within(r).getByText("Next 15 Jan 07:30")).toBeTruthy();
});

test("Run now calls runNow once while pending, then opens the chat", async () => {
  let finish: (v: unknown) => void = () => {};
  api.runNow.mockReturnValue(new Promise((ok) => (finish = ok)));
  renderPage([schedule("a", { name: "A" })]);
  const r = await row("A");
  await userEvent.click(runNowIn(r));
  await userEvent.click(runNowIn(r));
  expect(api.runNow).toHaveBeenCalledTimes(1);
  expect(api.runNow.mock.calls[0]?.[0]).toMatchObject({ id: "a" });
  expect(runNowIn(r).disabled).toBe(true);
  finish({ wakeId: "w1" });
  await waitFor(() => expect(path()).toBe("/c/bot:ray"));
});

test("Run now on CONFLICT shows Still running with a link to the chat", async () => {
  api.runNow.mockRejectedValue(Object.assign(new Error("busy"), { code: "CONFLICT" }));
  renderPage([schedule("a", { name: "A", conversationId: "group:crew" })]);
  const r = await row("A");
  await userEvent.click(runNowIn(r));
  expect(await within(r).findByText(/Still running/)).toBeTruthy();
  const link = within(r).getByRole("link", { name: "Open chat" });
  expect(link.getAttribute("href")).toBe("/c/group:crew");
  expect(path()).toBe("/schedules");
  expect(toast).not.toHaveBeenCalled();
});

test("the switch turns a schedule off", async () => {
  api.setEnabled.mockResolvedValue(schedule("a", { enabled: false }));
  renderPage([schedule("a", { name: "A" })]);
  await userEvent.click(within(await row("A")).getByRole("switch"));
  expect(api.setEnabled.mock.calls[0]?.[0]).toEqual({ id: "a", enabled: false });
  expect(path()).toBe("/schedules");
});

test("a row click opens the schedule page", async () => {
  renderPage([schedule("a", { name: "A" })]);
  await userEvent.click(await screen.findByText("Send me the news."));
  expect(path()).toBe("/schedules/a");
});

test("New schedule navigates to /schedules?new=1", async () => {
  renderPage([]);
  await userEvent.click(await screen.findByRole("button", { name: "New schedule" }));
  expect(path()).toBe("/schedules?new=1");
});

test("no schedules shows the empty state and the footnote", async () => {
  renderPage([]);
  expect(
    await screen.findByText(
      'No schedules yet. Ask a bot in chat ("every morning, send me…") or create one here.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "A scheduled run is a normal turn: it uses the bot's tools and memory, counts toward its daily spend limit and posts where you chose. Missed runs (Friday was off) run once when it starts again.",
    ),
  ).toBeTruthy();
});
