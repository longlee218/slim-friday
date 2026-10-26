import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ChatRowMenu } from "../../src/components/shell/chat-row-menu";

function renderMenu(kind: "bot" | "group", deletable = true) {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  render(
    <ChatRowMenu
      target={{ kind, id: "dev" }}
      name="Dev"
      deletable={deletable}
      onOpen={onOpen}
      onDelete={onDelete}
    >
      <a href="/c/bot:dev">Dev row</a>
    </ChatRowMenu>,
  );
  return { onOpen, onDelete };
}

test("right-click on a deletable bot: Open chat and a red Delete bot…", async () => {
  const { onDelete } = renderMenu("bot");
  fireEvent.contextMenu(screen.getByText("Dev row"));
  expect(await screen.findByRole("menuitem", { name: "Open chat" })).toBeTruthy();
  const del = screen.getByRole("menuitem", { name: "Delete bot…" });
  expect(del.className).toContain("danger");
  await userEvent.click(del);
  expect(onDelete).toHaveBeenCalledWith({ kind: "bot", id: "dev" });
});

test("a group row offers Delete group…", async () => {
  renderMenu("group");
  fireEvent.contextMenu(screen.getByText("Dev row"));
  expect(await screen.findByRole("menuitem", { name: "Delete group…" })).toBeTruthy();
});

test("a bot that cannot be deleted offers Open chat only", async () => {
  const { onOpen } = renderMenu("bot", false);
  fireEvent.contextMenu(screen.getByText("Dev row"));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open chat" }));
  expect(screen.queryByRole("menuitem", { name: /Delete/ })).toBeNull();
  expect(onOpen).toHaveBeenCalled();
});

test("the ⋯ button opens the same menu", async () => {
  renderMenu("bot");
  await userEvent.click(screen.getByRole("button", { name: "More for Dev" }));
  expect(await screen.findByRole("menuitem", { name: "Delete bot…" })).toBeTruthy();
});
