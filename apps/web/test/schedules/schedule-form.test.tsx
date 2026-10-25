import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { button, desktopMedia, field, news, renderPage } from "./page-harness";

const api = vi.hoisted(() => ({ get: vi.fn(), runs: vi.fn(), update: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  vi.resetAllMocks();
  api.runs.mockResolvedValue({ items: [] });
  api.update.mockResolvedValue(news());
  vi.stubGlobal("matchMedia", desktopMedia);
});

/** Renders the page serving `news(over)` and waits for the form. */
async function open(over: Parameters<typeof news>[0] = {}) {
  api.get.mockResolvedValue({ schedule: news(over) });
  renderPage();
  await screen.findByDisplayValue("Morning news");
}

test("Save is disabled while clean; an edit enables Save and Revert", async () => {
  await open();
  expect(button("Save").disabled).toBe(true);
  expect(button("Revert").disabled).toBe(true);
  await userEvent.type(field("Name"), "!");
  expect(button("Save").disabled).toBe(false);
  await userEvent.click(button("Revert"));
  expect(field("Name").value).toBe("Morning news");
});

test("the time zone is read-only text on the detail page", async () => {
  await open();
  expect(screen.getByText("Asia/Ho_Chi_Minh")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Time zone" })).toBeNull();
});

test("At 25:00: the field shows the message, Save stays enabled, nothing is saved", async () => {
  await open();
  const at = field("At");
  await userEvent.clear(at);
  await userEvent.type(at, "25:00");
  await userEvent.click(button("Save"));
  expect(await screen.findByText('time must be HH:MM (24 h), got "25:00"')).toBeTruthy();
  expect(api.update).not.toHaveBeenCalled();
  expect(button("Save").disabled).toBe(false);
  expect(field("At").value).toBe("25:00");
});

test("Interval of 10 minutes: at least 15 minutes, nothing is saved", async () => {
  await open();
  await userEvent.click(button("Interval"));
  await userEvent.clear(field("Every"));
  await userEvent.type(field("Every"), "10");
  await userEvent.click(button("Save"));
  expect(await screen.findByText(/at least 15 minutes/)).toBeTruthy();
  expect(api.update).not.toHaveBeenCalled();
  expect(button("Save").disabled).toBe(false);
});

test("a stale Every error clears when the unit or Repeat changes", async () => {
  await open();
  await userEvent.click(button("Interval"));
  await userEvent.clear(field("Every"));
  await userEvent.type(field("Every"), "10");
  await userEvent.click(button("Save"));
  await screen.findByText(/at least 15 minutes/);
  await userEvent.click(button("Every day"));
  await userEvent.click(button("Interval"));
  expect(screen.queryByText(/at least 15 minutes/)).toBeNull();
  await userEvent.click(button("Save"));
  await screen.findByText(/at least 15 minutes/);
  await userEvent.click(screen.getByRole("combobox", { name: "Unit" }));
  await userEvent.click(await screen.findByRole("option", { name: "hours" }));
  expect(screen.queryByText(/at least 15 minutes/)).toBeNull();
});

test("a server BAD_REQUEST shows under the form and nothing is cleared", async () => {
  api.update.mockRejectedValue({ code: "BAD_REQUEST", message: "That time is already past." });
  await open();
  await userEvent.type(field("Name"), " 2");
  await userEvent.click(button("Save"));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("That time is already past.");
  expect(button("Save").getAttribute("aria-describedby")).toBe(alert.id);
  expect(field("Name").value).toBe("Morning news 2");
  expect(button("Save").disabled).toBe(false);
});

test("a rename sends only the name (no rule, so the next run stays)", async () => {
  await open({ rule: { kind: "interval", every: 30, unit: "minutes" } });
  await userEvent.type(field("Name"), " 2");
  await userEvent.click(button("Save"));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith({ id: "a", name: "Morning news 2" }));
});

test("renaming a finished Once schedule sends no rule", async () => {
  await open({
    rule: { kind: "once", date: "2026-01-02", at: "08:00" },
    enabled: false,
    disabledReason: "done",
  });
  await userEvent.type(field("Name"), " 2");
  await userEvent.click(button("Save"));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith({ id: "a", name: "Morning news 2" }));
});

test("a time change sends only the rule", async () => {
  await open();
  await userEvent.clear(field("At"));
  await userEvent.type(field("At"), "08:00");
  await userEvent.click(button("Save"));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith({ id: "a", rule: { kind: "daily", at: "08:00" } }),
  );
});

test("Weekly shows the weekday picker; a valid save sends the rule", async () => {
  await open();
  expect(screen.queryByRole("combobox", { name: "Weekday" })).toBeNull();
  await userEvent.click(button("Weekly"));
  await userEvent.click(screen.getByRole("combobox", { name: "Weekday" }));
  await userEvent.click(await screen.findByRole("option", { name: "Friday" }));
  await userEvent.click(button("Save"));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith({
      id: "a",
      rule: { kind: "weekly", at: "07:30", weekday: 5 },
    }),
  );
});

test("switching to Once seeds today's date", async () => {
  await open();
  await userEvent.click(button("Once"));
  expect(field("Date").value).toBe(new Date().toLocaleDateString("en-CA"));
});
