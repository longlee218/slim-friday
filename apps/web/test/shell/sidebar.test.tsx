import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { Sidebar } from "../../src/components/shell/sidebar";
import { trailingMark } from "../../src/components/shell/sidebar-row";
import { approval, bot, conv, group, seededClient, status } from "./fixtures";

const Path = () => <output data-testid="path">{useLocation().pathname}</output>;

function renderSidebar(seed: Parameters<typeof seededClient>[0], onPalette = vi.fn()) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <Sidebar onPalette={onPalette} />
            <Path />
          </>
        ),
      },
    ],
    { initialEntries: ["/c/bot:dev"] },
  );
  render(
    <QueryClientProvider client={seededClient(seed)}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return onPalette;
}

const seed = {
  bots: [bot("dev", "Dev"), bot("pia", "Pia"), bot("ray", "Ray")],
  groups: [group("core", "Core team", ["dev", "pia"])],
  conversations: [conv("bot:dev", 3), conv("bot:pia", 2), conv("group:core", 0)],
  status: [status("ray", "Ray", true, "Reading"), status("dev", "Dev", false)],
  approvals: [approval("a1", "dev")],
};

beforeEach(() => {
  window.innerWidth = 1200;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

test("trailing mark priority", () => {
  expect(trailingMark({ approvals: 1, unread: 3, working: true })).toEqual({
    kind: "approval",
    count: 1,
  });
  expect(trailingMark({ approvals: 0, unread: 3, working: true })).toEqual({
    kind: "unread",
    count: 3,
  });
  expect(trailingMark({ approvals: 0, unread: 0, working: true })).toEqual({ kind: "working" });
  expect(trailingMark({ approvals: 0, unread: 0, working: false })).toEqual({ kind: "none" });
});

test("sidebar row shows the amber approval count over unread", () => {
  renderSidebar(seed);
  const dev = screen.getByRole("link", { name: /Dev/ });
  const badge = within(dev).getByText("1");
  expect(badge.className).toContain("amber");
  expect(within(dev).queryByText("3")).toBeNull();
  // unread without a card: tint badge; a working bot without either: "working".
  expect(within(screen.getByRole("link", { name: /Pia/ })).getByText("2").className).toContain(
    "tint",
  );
  expect(within(screen.getByRole("link", { name: /Ray/ })).getByText("working")).toBeTruthy();
});

test("the open conversation row carries the shared selection element", () => {
  renderSidebar(seed);
  expect(screen.getByRole("link", { name: /Dev/ }).querySelector(".sel")).not.toBeNull();
  expect(screen.getByRole("link", { name: /Pia/ }).querySelector(".sel")).toBeNull();
});

test("sections, workspace rows and footer", async () => {
  renderSidebar(seed);
  for (const t of ["Bots", "Groups", "Workspace"]) expect(screen.getByText(t)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Tickets" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Activity" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Owner/ }).getAttribute("href")).toBe(
    "/settings/account",
  );
  await userEvent.click(screen.getByRole("button", { name: "New group" }));
  expect(screen.getByTestId("path").textContent).toBe("/settings/group/new");
  await userEvent.click(screen.getByRole("button", { name: "New bot" }));
  expect(screen.getByTestId("path").textContent).toBe("/settings/bot/new");
});

test("a row navigates through the router", async () => {
  renderSidebar(seed);
  await userEvent.click(screen.getByRole("link", { name: /Pia/ }));
  expect(screen.getByTestId("path").textContent).toBe("/c/bot:pia");
});

test("New chat and the search field open the palette", async () => {
  const onPalette = renderSidebar(seed);
  await userEvent.click(screen.getByRole("button", { name: "New chat" }));
  await userEvent.click(screen.getByPlaceholderText("Search"));
  expect(onPalette).toHaveBeenCalledTimes(2);
});
