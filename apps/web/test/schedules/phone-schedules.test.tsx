import type { ScheduleDto } from "@friday/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { phoneClient, renderPhone, stubMatchMedia } from "../phone/phone-fixtures";
import { run, schedule } from "./fixtures";

// The real client, except `schedules.create` and `schedules.delete`.
const create = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("../../src/api/client", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/api/client")>();
  const swap = <T extends object>(t: T, key: string, v: unknown) =>
    new Proxy(t, { get: (o, k) => (k === key ? v : Reflect.get(o, k)) });
  const schedules = swap(swap(m.client.schedules, "create", create), "delete", del);
  return { ...m, client: swap(m.client, "schedules", schedules) };
});

beforeEach(() => {
  create.mockReset();
  del.mockReset();
  stubMatchMedia();
  window.innerWidth = 390;
});

const news = (over: Partial<ScheduleDto> = {}) =>
  schedule("a", { name: "Morning news", last: run("ok"), ...over });

/** The phone client with `items` as the schedules list (and `a` served by `get`). */
function client(items: ScheduleDto[]) {
  const qc = phoneClient();
  qc.setQueryData(orpc.schedules.list.queryKey({ input: {} }), { items });
  const a = items.find((s) => s.id === "a");
  if (a) qc.setQueryData(orpc.schedules.get.queryKey({ input: { id: "a" } }), { schedule: a });
  return qc;
}

/** The view on top of the stack (the one not under it, not sliding out). */
const top = () => {
  const views = [...document.querySelectorAll(".ios-view:not(.under):not(.leave)")];
  return views.at(-1) as HTMLElement;
};
const backText = () => top().querySelector(".ios-nav .back")?.textContent;
const activeTab = () => document.querySelector(".tabbar [aria-current=page]")?.textContent;

test("phone Settings has Schedules with the on count; it opens the phone list", async () => {
  const { router } = renderPhone(
    client([news(), schedule("b", { name: "Weekly report", enabled: false })]),
    "/settings",
  );
  const entry = screen.getByRole("link", { name: /Schedules/ });
  expect(entry.getAttribute("href")).toBe("/schedules");
  expect(within(entry).getByText("1 on")).toBeTruthy();
  expect(entry.querySelector(".chev")).toBeTruthy();
  fireEvent.click(entry);
  expect(router.state.location.pathname).toBe("/schedules");
  await waitFor(() => expect(backText()).toBe("Settings"));
  expect(activeTab()).toBe("Settings");
  const row = within(top()).getByRole("link", { name: /Morning news/ });
  expect(row.getAttribute("href")).toBe("/schedules/a");
  expect(within(row).getByText("OK")).toBeTruthy();
  expect(row.querySelector(".chev")).toBeTruthy();
  expect(within(row).getByText(/^Every day 07:30 \(Asia\/Ho_Chi_Minh\) · Next /)).toBeTruthy();
  const off = within(top()).getByRole("link", { name: /Weekly report/ });
  expect(within(off).getAllByText(/Paused/).length).toBeGreaterThan(0);
});

test("the phone list opens the schedule page; back reads Schedules", async () => {
  const { router } = renderPhone(client([news()]), "/schedules");
  fireEvent.click(within(top()).getByRole("link", { name: /Morning news/ }));
  expect(router.state.location.pathname).toBe("/schedules/a");
  await waitFor(() => expect(backText()).toBe("Schedules"));
});

test("a cold schedule page sits under Settings › Schedules with Save, Run now and Delete", async () => {
  const { router } = renderPhone(client([news()]), "/schedules/a");
  expect(backText()).toBe("Schedules");
  expect(activeTab()).toBe("Settings");
  const view = within(top());
  expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByRole("button", { name: "Run now" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Delete schedule" }));
  expect(await screen.findByText("Delete Morning news?")).toBeTruthy();
  expect(document.querySelector(".bsheet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(top().querySelector(".ios-nav .back") as HTMLElement);
  await waitFor(() => expect(router.state.location.pathname).toBe("/schedules"));
});

test("New schedule on the phone list opens the bottom sheet", async () => {
  const { router } = renderPhone(client([]), "/schedules");
  fireEvent.click(within(top()).getByRole("button", { name: "New schedule" }));
  expect(router.state.location.search).toBe("?new=1");
  await waitFor(() => expect(document.querySelector(".bsheet")).toBeTruthy());
});

/** Opens Settings › Schedules › + (the new sheet) on the phone; returns the router and qc. */
async function openNewFromSettings(items: ScheduleDto[] = []) {
  const qc = client(items);
  const r = renderPhone(qc, "/settings");
  fireEvent.click(screen.getByRole("link", { name: /Schedules/ }));
  await waitFor(() => expect(backText()).toBe("Settings"));
  fireEvent.click(within(top()).getByRole("button", { name: "New schedule" }));
  const sheet = await screen.findByRole("dialog");
  return { ...r, qc, sheet };
}
const back = () => fireEvent.click(top().querySelector(".ios-nav .back") as HTMLElement);

test("cancel the new sheet, then ONE Back returns to Settings", async () => {
  const { router, sheet } = await openNewFromSettings();
  fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(router.state.location.search).toBe(""));
  back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
});

test("create, then Back lands on the list, then on Settings", async () => {
  const made = schedule("s9", { name: "Evening wrap-up" });
  create.mockResolvedValue(made);
  const { router, qc, sheet } = await openNewFromSettings();
  qc.setQueryData(orpc.schedules.get.queryKey({ input: { id: "s9" } }), { schedule: made });
  await userEvent.type(within(sheet).getByLabelText("Name"), "Evening wrap-up");
  await userEvent.type(within(sheet).getByLabelText("Task"), "Sum up the day.");
  await userEvent.click(within(sheet).getByRole("button", { name: "Create schedule" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/schedules/s9"));
  await waitFor(() => expect(backText()).toBe("Schedules"));
  back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/schedules"));
  back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
});

test("New schedule from another tab (the palette): cancel, then ONE Back returns there", async () => {
  const { router } = renderPhone(client([]), "/");
  await router.navigate("/schedules?new=1"); // what the palette does away from /schedules
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
  );
  await waitFor(() => expect(router.state.location.search).toBe(""));
  await waitFor(() => expect(backText()).toBe("Chats"));
  back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});

test("delete from the schedule page, then ONE Back returns to Settings, never the deleted page", async () => {
  del.mockResolvedValue({});
  const { router } = renderPhone(client([news()]), "/settings");
  fireEvent.click(screen.getByRole("link", { name: /Schedules/ }));
  await waitFor(() => expect(backText()).toBe("Settings"));
  fireEvent.click(within(top()).getByRole("link", { name: /Morning news/ }));
  await waitFor(() => expect(backText()).toBe("Schedules"));
  fireEvent.click(within(top()).getByRole("button", { name: "Delete schedule" }));
  const sheet = await screen.findByRole("dialog");
  fireEvent.click(within(sheet).getByRole("button", { name: "Delete schedule" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/schedules"));
  await waitFor(() => expect(backText()).toBe("Settings"));
  back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
});
