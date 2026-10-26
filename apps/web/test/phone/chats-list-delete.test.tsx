import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatsList } from "../../src/components/phone/chats-list";
import { bot, group, seededClient } from "../shell/fixtures";

vi.mock("../../src/app/shell-context", () => ({ useOpenPalette: () => () => {} }));

beforeEach(() => {
  window.innerWidth = 390;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

function renderList() {
  const qc = seededClient({
    // Dev is an owner bot in Crew; Friday is shipped (no Delete).
    bots: [{ ...bot("dev", "Dev"), deletable: true }, bot("friday", "Friday")],
    groups: [group("crew", "Crew", ["dev"])],
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={createMemoryRouter([{ path: "*", element: <ChatsList /> }], {
          initialEntries: ["/"],
        })}
      />
    </QueryClientProvider>,
  );
}

const drag = (el: Element, dx: number) => {
  fireEvent.pointerDown(el, { clientX: 300, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 300 + dx, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 300 + dx, clientY: 100, pointerId: 1 });
};

test("swiping a deletable bot reveals Delete; tapping it opens the confirm sheet", async () => {
  renderList();
  drag(screen.getByText("Dev"), -70);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Delete Dev?")).toBeTruthy();
  expect(within(sheet).getByText("Crew is deleted too.")).toBeTruthy();
});

test("a shipped bot has no Delete action; a group has one", () => {
  renderList();
  drag(screen.getByText("Friday"), -70);
  // Only the group row and Dev render a (hidden) Delete button; Friday has none.
  expect(document.querySelectorAll(".swrow")).toHaveLength(2);
});
