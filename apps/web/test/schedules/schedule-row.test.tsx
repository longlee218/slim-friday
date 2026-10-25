import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { run, schedule } from "./fixtures";
import { renderList, row, runNowIn } from "./list-harness";

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

test("a refused switch toasts the board's message", async () => {
  api.setEnabled.mockRejectedValue(
    Object.assign(new Error("That time is already past."), { code: "BAD_REQUEST" }),
  );
  renderPage([schedule("a", { name: "A", enabled: false })]);
  await userEvent.click(within(await row("A")).getByRole("switch"));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("That time is already past."));
});
