import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { DeleteChatSheet } from "../../src/components/shell/delete-chat-sheet";
import { bot, group, seededClient } from "./fixtures";

const api = vi.hoisted(() => ({ botsDelete: vi.fn(), groupsDelete: vi.fn() }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { config: { bots: { delete: api.botsDelete }, groups: { delete: api.groupsDelete } } },
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const Path = () => <output data-testid="path">{useLocation().pathname}</output>;

const seed = {
  bots: [bot("dev", "Dev"), bot("ann", "Ann")],
  // Team: dev is the entry bot; Solo: dev is the only member.
  groups: [group("team", "Team", ["dev", "ann"]), group("solo", "Solo", ["dev"])],
};

function renderSheet(target: { kind: "bot" | "group"; id: string }, at = "/") {
  const onClose = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <DeleteChatSheet target={target} onClose={onClose} />
            <Path />
          </>
        ),
      },
    ],
    { initialEntries: [at] },
  );
  const qc = seededClient(seed);
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return Object.assign(onClose, { qc });
}

beforeEach(() => {
  vi.resetAllMocks();
  window.innerWidth = 1200;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

test("a bot in groups: the sheet names each group's outcome and the button is red", async () => {
  renderSheet({ kind: "bot", id: "dev" });
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Delete Dev?")).toBeTruthy();
  expect(within(sheet).getByText(/moves to the trash for 7 days/)).toBeTruthy();
  expect(within(sheet).getByText("Removed from Team. New entry bot: Ann.")).toBeTruthy();
  expect(within(sheet).getByText("Solo is deleted too.")).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: "Delete bot" }).className).toContain("danger");
});

test("Delete removes the bot with cascade, toasts and leaves its open chat", async () => {
  api.botsDelete.mockResolvedValue({ ok: true });
  const onClose = renderSheet({ kind: "bot", id: "dev" }, "/c/bot:dev");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
  // Desktop: `/` would bounce back to the last chat, so it goes to the Friday chat.
  await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/c/bot:friday"));
  expect(api.botsDelete).toHaveBeenCalledWith({ id: "dev", cascade: true });
  expect(toast).toHaveBeenCalledWith("Dev deleted.");
  expect(onClose).toHaveBeenCalled();
});

test("deleting a chat that is not open stays where it is", async () => {
  api.botsDelete.mockResolvedValue({ ok: true });
  renderSheet({ kind: "bot", id: "dev" }, "/c/bot:ann");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(screen.getByTestId("path").textContent).toBe("/c/bot:ann");
});

test("a refusal toasts the error and keeps the sheet open", async () => {
  api.botsDelete.mockRejectedValue({ code: "BAD_REQUEST", message: "bot is reserved" });
  const onClose = renderSheet({ kind: "bot", id: "dev" });
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("a group: its members stay, and groups.delete is called", async () => {
  api.groupsDelete.mockResolvedValue({ ok: true });
  renderSheet({ kind: "group", id: "team" });
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Delete Team?")).toBeTruthy();
  expect(within(sheet).getByText(/Its members stay\./)).toBeTruthy();
  await userEvent.click(within(sheet).getByRole("button", { name: "Delete group" }));
  await waitFor(() => expect(api.groupsDelete).toHaveBeenCalledWith({ id: "team" }));
});

test("on the phone leaving the open chat goes to the Chats list", async () => {
  window.innerWidth = 390;
  api.botsDelete.mockResolvedValue({ ok: true });
  renderSheet({ kind: "bot", id: "dev" }, "/c/bot:dev");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/"));
});

test("a group the cascade deletes is left too when its chat is open", async () => {
  api.botsDelete.mockResolvedValue({ ok: true });
  renderSheet({ kind: "bot", id: "dev" }, "/c/group:solo");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/c/bot:friday"));
});

test("a failed delete still refreshes bots and groups, so the sheet is not stale", async () => {
  api.botsDelete.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR", message: "disk" });
  const view = renderSheet({ kind: "bot", id: "dev" });
  const spy = vi.spyOn(view.qc, "invalidateQueries");
  await userEvent.click(await screen.findByRole("button", { name: "Delete bot" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
  expect(spy).toHaveBeenCalledWith({ queryKey: orpc.config.groups.key() });
});
