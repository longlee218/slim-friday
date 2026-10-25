import type { ScheduleDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { SchedulePageRoute } from "../../src/components/schedules/schedule-page-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { bot, group, seededClient } from "../shell/fixtures";
import { run, schedule } from "./fixtures";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  runs: vi.fn(),
  update: vi.fn(),
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
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

const Where = () => {
  const l = useLocation();
  return <output data-testid="path">{l.pathname + l.search}</output>;
};
const path = () => screen.getByTestId("path").textContent;

/** Renders `/schedules/a` serving `s` (or the `get` mock as set), Ray and Crew in the directory. */
function renderPage(s?: ScheduleDto) {
  if (s) api.get.mockResolvedValue({ schedule: s });
  const qc = seededClient({ bots: [bot("ray", "Ray")], groups: [group("crew", "Crew", ["ray"])] });
  return render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/schedules/a"]}>
          <Where />
          <Routes>
            <Route path="/schedules/:id" element={<SchedulePageRoute />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
}

const news = (over: Partial<ScheduleDto> = {}) =>
  schedule("a", { name: "Morning news", timeZone: "Asia/Ho_Chi_Minh", ...over });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

test("Save is disabled while clean; an edit enables Save and Revert", async () => {
  renderPage(news());
  await screen.findByDisplayValue("Morning news");
  expect(button("Save").disabled).toBe(true);
  expect(button("Revert").disabled).toBe(true);
  await userEvent.type(field("Name"), "!");
  expect(button("Save").disabled).toBe(false);
  await userEvent.click(button("Revert"));
  expect(field("Name").value).toBe("Morning news");
});

test("the time zone is read-only text on the detail page", async () => {
  renderPage(news());
  await screen.findByDisplayValue("Morning news");
  expect(screen.getByText("Asia/Ho_Chi_Minh")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Time zone" })).toBeNull();
});

test("At 25:00: the field shows the message, Save stays enabled, nothing is saved", async () => {
  renderPage(news());
  const at = await screen.findByDisplayValue("07:30");
  await userEvent.clear(at);
  await userEvent.type(at, "25:00");
  await userEvent.click(button("Save"));
  expect(await screen.findByText('time must be HH:MM (24 h), got "25:00"')).toBeTruthy();
  expect(api.update).not.toHaveBeenCalled();
  expect(button("Save").disabled).toBe(false);
  expect(field("At").value).toBe("25:00");
});

test("Interval of 10 minutes: at least 15 minutes, nothing is saved", async () => {
  renderPage(news());
  await screen.findByDisplayValue("Morning news");
  await userEvent.click(button("Interval"));
  const every = field("Every");
  await userEvent.clear(every);
  await userEvent.type(every, "10");
  await userEvent.click(button("Save"));
  expect(await screen.findByText(/at least 15 minutes/)).toBeTruthy();
  expect(api.update).not.toHaveBeenCalled();
  expect(button("Save").disabled).toBe(false);
});

test("a server BAD_REQUEST shows under the form and nothing is cleared", async () => {
  api.update.mockRejectedValue({ code: "BAD_REQUEST", message: "That time is already past." });
  renderPage(news());
  await userEvent.type(await screen.findByDisplayValue("Morning news"), " 2");
  await userEvent.click(button("Save"));
  expect((await screen.findByRole("alert")).textContent).toBe("That time is already past.");
  expect(field("Name").value).toBe("Morning news 2");
  expect(button("Save").disabled).toBe(false);
  expect(api.update).toHaveBeenCalledWith({
    id: "a",
    name: "Morning news 2",
    task: "Send me the news.",
    rule: { kind: "daily", at: "07:30" },
    notify: "always",
  });
});

test("Weekly shows the weekday picker; a valid save sends the rule", async () => {
  api.update.mockResolvedValue(news());
  renderPage(news());
  await screen.findByDisplayValue("Morning news");
  expect(screen.queryByRole("combobox", { name: "Weekday" })).toBeNull();
  await userEvent.click(button("Weekly"));
  await userEvent.click(screen.getByRole("combobox", { name: "Weekday" }));
  await userEvent.click(await screen.findByRole("option", { name: "Friday" }));
  await userEvent.click(button("Save"));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith(
      expect.objectContaining({ rule: { kind: "weekly", at: "07:30", weekday: 5 } }),
    ),
  );
});

test("the header says when, where and next; bot and Post to are read-only", async () => {
  renderPage(news({ when: "Every day 07:30 (Asia/Ho_Chi_Minh)", conversationId: "group:crew" }));
  expect(await screen.findByText(/Every day 07:30 \(Asia\/Ho_Chi_Minh\) · posts to Crew · next/));
  expect(screen.queryByRole("combobox", { name: "Bot" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Post to" })).toBeNull();
});

test("Delete asks with the exact copy, deletes and returns to the list without not-found", async () => {
  api.delete.mockResolvedValue({});
  renderPage(news());
  await screen.findByDisplayValue("Morning news");
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
  renderPage(news({ enabled: false, disabledReason: "bot_gone" }));
  await screen.findByDisplayValue("Morning news");
  expect(screen.getByText(/bot is gone/i)).toBeTruthy();
  expect(field("Name").disabled).toBe(true);
  expect(field("Task").disabled).toBe(true);
  expect(button("Delete").disabled).toBe(false);
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
});

test("Run now while a run is going says Still running with a link to the chat", async () => {
  api.runNow.mockRejectedValue({ code: "CONFLICT", message: "busy" });
  renderPage(news());
  await screen.findByDisplayValue("Morning news");
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
  renderPage(news());
  const ok = await screen.findByText("OK", { selector: ".sched-runs .pill" });
  expect(ok.closest("a")?.getAttribute("href")).toBe("/c/bot:ray");
  await userEvent.click(button("Load more"));
  expect(await screen.findByText("Timed out")).toBeTruthy();
  expect(api.runs).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "a", before: 50 }),
    expect.anything(),
  );
});
