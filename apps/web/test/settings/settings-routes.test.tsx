import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { settingsRoutes } from "../../src/components/settings/settings-routes";
import { bot, group, seededClient } from "../shell/fixtures";

// The toolbar needs the app shell's panels; this test is about the routes.
vi.mock("../../src/components/shell/toolbar", () => ({ Toolbar: () => null }));

function open(path: string) {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.innerWidth = 1200;
  const dev = { ...bot("dev", "Dev"), title: "Builder" };
  const qc = seededClient({ bots: [dev], groups: [group("crew", "Crew", ["dev"])] });
  qc.setQueryData(orpc.config.bots.get.queryKey({ input: { id: "dev" } }), dev);
  qc.setQueryData(orpc.config.skills.list.queryKey(), []);
  qc.setQueryData(orpc.config.mcp.list.queryKey(), []);
  const router = createMemoryRouter(settingsRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

test("/settings opens the first bot's profile on desktop, with the list beside it", async () => {
  const router = open("/settings");
  expect(await screen.findByLabelText("Title")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/settings/bot/dev/profile");
  expect(screen.getByText("New group")).toBeTruthy();
});

test("a tab button moves to that tab and keeps the bot", async () => {
  const router = open("/settings/bot/dev/profile");
  await userEvent.click(await screen.findByRole("tab", { name: "Tools & skills" }));
  expect(router.state.location.pathname).toBe("/settings/bot/dev/tools");
  expect(await screen.findByText("Add tool")).toBeTruthy();
});
