import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { SchedulesRoute } from "../../src/components/schedules/schedules-route";
import { PanelsContext } from "../../src/components/shell/use-responsive-panels";
import { bot, group, seededClient } from "../shell/fixtures";
import { schedule } from "./fixtures";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../../src/api/client", async () => (await import("./mock-client")).mockApi(api));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue({ items: [] });
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

/** Renders `/schedules?new=1` with Ray (in Crew) and Kai (in no group). */
function renderSheet() {
  const qc = seededClient({
    bots: [bot("ray", "Ray"), bot("kai", "Kai")],
    groups: [group("crew", "Crew", ["ray"])],
  });
  render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={{ toggle: () => {} } as never}>
        <MemoryRouter initialEntries={["/schedules?new=1"]}>
          <Where />
          <Routes>
            <Route path="/schedules" element={<SchedulesRoute />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
  return screen.findByRole("dialog");
}

/** Types a name and a task, the two fields Create needs. */
async function fill(sheet: HTMLElement) {
  await userEvent.type(within(sheet).getByLabelText("Name"), "Evening wrap-up");
  await userEvent.type(within(sheet).getByLabelText("Task"), "Sum up the day.");
}

test("?new=1 opens the sheet; Create needs a name and a task; it posts to the bot's chat", async () => {
  api.create.mockResolvedValue(schedule("s9"));
  const sheet = await renderSheet();
  const create = within(sheet).getByRole("button", {
    name: "Create schedule",
  }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(within(sheet).getByRole("combobox", { name: "Time zone" })).toBeTruthy();
  await fill(sheet);
  await userEvent.click(create);
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith({
      name: "Evening wrap-up",
      botId: "ray",
      task: "Sum up the day.",
      rule: { kind: "daily", at: "09:00" },
      conversationId: "bot:ray",
      notify: "always",
    }),
  );
  await waitFor(() => expect(path()).toBe("/schedules/s9"));
});

test("posting to a group the bot is in, only problems", async () => {
  api.create.mockResolvedValue(schedule("s9"));
  const sheet = await renderSheet();
  await fill(sheet);
  await userEvent.click(within(sheet).getByRole("combobox", { name: "Post to" }));
  expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Ray", "Crew"]);
  await userEvent.click(screen.getByRole("option", { name: "Crew" }));
  await userEvent.click(within(sheet).getByRole("button", { name: "Only problems" }));
  await userEvent.click(within(sheet).getByRole("button", { name: "Create schedule" }));
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "ray", conversationId: "group:crew", notify: "problems" }),
    ),
  );
});

test("a chosen time zone is sent by its IANA name", async () => {
  api.create.mockResolvedValue(schedule("s9"));
  const sheet = await renderSheet();
  await fill(sheet);
  await userEvent.click(within(sheet).getByRole("combobox", { name: "Time zone" }));
  await userEvent.click(await screen.findByRole("option", { name: "Asia/Tokyo" }));
  await userEvent.click(within(sheet).getByRole("button", { name: "Create schedule" }));
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ timeZone: "Asia/Tokyo" })),
  );
});

test("a bot change resets Post to the new bot's own chat", async () => {
  api.create.mockResolvedValue(schedule("s9"));
  const sheet = await renderSheet();
  await fill(sheet);
  await userEvent.click(within(sheet).getByRole("combobox", { name: "Post to" }));
  await userEvent.click(await screen.findByRole("option", { name: "Crew" }));
  await userEvent.click(within(sheet).getByRole("combobox", { name: "Bot" }));
  await userEvent.click(await screen.findByRole("option", { name: /Kai/ }));
  expect(within(sheet).getByRole("combobox", { name: "Post to" }).textContent).toBe("Kai");
  await userEvent.click(within(sheet).getByRole("button", { name: "Create schedule" }));
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "kai", conversationId: "bot:kai" }),
    ),
  );
});

test("a server BAD_REQUEST shows in the sheet and keeps what was typed", async () => {
  api.create.mockRejectedValue({ code: "BAD_REQUEST", message: "That time is already past." });
  const sheet = await renderSheet();
  await fill(sheet);
  await userEvent.click(within(sheet).getByRole("button", { name: "Create schedule" }));
  expect((await within(sheet).findByRole("alert")).textContent).toBe("That time is already past.");
  expect((within(sheet).getByLabelText("Name") as HTMLInputElement).value).toBe("Evening wrap-up");
  expect(path()).toBe("/schedules?new=1");
});

test("Cancel closes the sheet and drops ?new=1", async () => {
  const sheet = await renderSheet();
  await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(path()).toBe("/schedules"));
});

test("phone: the bar holds Cancel and Create; no bottom buttons; one create per tap", async () => {
  window.innerWidth = 390;
  try {
    api.create.mockImplementation(() => new Promise(() => {}));
    const sheet = await renderSheet();
    const bar = sheet.querySelector(".bs-bar") as HTMLElement;
    expect(within(bar).getByRole("button", { name: "Cancel" })).toBeTruthy();
    const create = within(bar).getByRole("button", { name: "Create schedule" });
    expect(sheet.querySelector(".acts")).toBeNull();
    expect(within(sheet).getByLabelText("Name").closest(".bs-body")).not.toBeNull();
    await fill(sheet);
    await userEvent.click(create);
    await userEvent.click(create);
    expect(api.create).toHaveBeenCalledTimes(1);
  } finally {
    window.innerWidth = 1024;
  }
});
