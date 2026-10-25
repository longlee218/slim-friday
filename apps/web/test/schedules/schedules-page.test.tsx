import type { ScheduleDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { SchedulesRoute } from "../../src/components/schedules/schedules-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { bot, group, seededClient } from "../shell/fixtures";
import { run, schedule } from "./fixtures";

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

/** Shows the router's location so a test can see where the page navigated. */
const Where = () => {
  const l = useLocation();
  return <output data-testid="path">{l.pathname + l.search}</output>;
};
const path = () => screen.getByTestId("path").textContent;

/** Renders `/schedules` serving `items`, with Ray and the Crew group in the directory. */
function renderPage(items: ScheduleDto[]) {
  api.list.mockResolvedValue({ items });
  const qc = seededClient({
    bots: [bot("ray", "Ray")],
    groups: [group("crew", "Crew", ["ray"])],
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/schedules"]}>
          <Where />
          <SchedulesRoute />
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

/** The row of the schedule named `name`. */
const row = async (name: string) =>
  (await screen.findByText(name)).closest(".sched-row") as HTMLElement;
/** Run now of a row is named after its schedule. */
const runNowIn = (r: HTMLElement) =>
  within(r).getByRole("button", { name: /^Run .+ now$/ }) as HTMLButtonElement;

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

test("Run now of a row is named after the schedule", async () => {
  renderPage([schedule("a", { name: "Morning news" })]);
  expect(await screen.findByRole("button", { name: "Run Morning news now" })).toBeTruthy();
});

test("Still running clears once the schedule's last run changes", async () => {
  api.runNow.mockRejectedValue(Object.assign(new Error("busy"), { code: "CONFLICT" }));
  const { qc } = renderPage([schedule("a", { name: "A", last: run("running") })]);
  const r = await row("A");
  await userEvent.click(runNowIn(r));
  expect(await within(r).findByText(/Still running/)).toBeTruthy();
  act(() =>
    qc.setQueryData(orpc.schedules.list.queryKey({ input: {} }), {
      items: [schedule("a", { name: "A", last: { ...run("ok"), id: "r-next" } })],
    }),
  );
  await waitFor(() => expect(within(r).queryByText(/Still running/)).toBeNull());
});

test("a finished or gone schedule shows only its pill, not a second Paused", async () => {
  renderPage([
    schedule("a", { name: "A", enabled: false, disabledReason: "done" }),
    schedule("b", { name: "B", enabled: false, disabledReason: "group_gone" }),
    schedule("c", { name: "C", enabled: false }),
  ]);
  expect(within(await row("A")).getByText("Done")).toBeTruthy();
  expect(within(await row("A")).queryByText("Paused")).toBeNull();
  expect(within(await row("B")).queryByText("Paused")).toBeNull();
  expect(within(await row("C")).getAllByText("Paused")).toHaveLength(2);
});
