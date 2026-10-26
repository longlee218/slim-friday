import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, expect, test } from "vitest";
import { PhoneShell } from "../../src/components/phone/phone-shell";
import { phoneClient, renderPhone, stubMatchMedia } from "./phone-fixtures";

beforeEach(() => {
  stubMatchMedia();
  window.innerWidth = 390;
});

const tabbar = () => document.querySelector(".tabbar") as HTMLElement;

test("tab bar is visible at / and shows the approvals badge on Activity", () => {
  renderPhone(phoneClient(), "/");
  expect(tabbar().className).not.toContain("hidden");
  const names = within(tabbar())
    .getAllByRole("button")
    .map((b) => b.textContent);
  expect(names).toEqual(["Chats", "Tickets", "Activity1", "Settings"]);
  expect(within(tabbar()).getByText("1").className).toContain("tb");
});

test("tab bar hides when a chat is pushed", () => {
  renderPhone(phoneClient(), "/c/bot:dev");
  expect(tabbar().className).toContain("hidden");
});

test("tab buttons switch the tab and reset the stack", () => {
  const { router } = renderPhone(phoneClient(), "/");
  fireEvent.click(within(tabbar()).getByText("Tickets"));
  expect(router.state.location.pathname).toBe("/tickets");
  expect(tabbar().className).not.toContain("hidden");
});

test("chats list pills, previews and live row", () => {
  renderPhone(phoneClient(), "/");
  const dev = screen.getByText("Dev").closest(".crow") as HTMLElement;
  expect(within(dev).getByText("Approval").className).toContain("amber");
  expect(within(dev).getByText("Running tests…")).toBeTruthy();
  const crew = screen.getByText("Crew").closest(".crow") as HTMLElement;
  expect(within(crew).getByText("Question").className).toContain("blue");
  expect(within(crew).getByText("No messages yet")).toBeTruthy();
  const pia = screen.getByText("Pia").closest(".crow") as HTMLElement;
  expect(within(pia).getByText(/Pia → Dev: draft is ready/)).toBeTruthy();
  expect(screen.getByText("1 bot working")).toBeTruthy();
  expect(screen.getByText("1 approval waiting · $1.50 today")).toBeTruthy();
});

test("a row with an open approval shows the amber count, not the unread count", () => {
  renderPhone(phoneClient(), "/");
  const dev = screen.getByText("Dev").closest(".crow") as HTMLElement;
  expect(dev.querySelector(".badge.amber")?.textContent).toBe("1");
  expect(dev.querySelector(".badge.tint")).toBeNull();
});

test("search filters the list by name", () => {
  renderPhone(phoneClient(), "/");
  fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "pi" } });
  expect(screen.queryByText("Crew")).toBeNull();
  expect(screen.getByText("Pia")).toBeTruthy();
});

test("opening a row pushes the chat; its title opens the bot settings with back reading Chat", () => {
  const { router } = renderPhone(phoneClient(), "/");
  fireEvent.click(screen.getByText("Dev").closest(".crow") as HTMLElement);
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  const nav = document.querySelector(".chatnav") as HTMLElement;
  expect(within(nav).getByText("Chats")).toBeTruthy();
  expect(within(nav).getByText("Running tests")).toBeTruthy();
  fireEvent.click(within(nav).getByLabelText("Dev details"));
  expect(router.state.location.pathname).toBe("/settings/bot/dev");
  expect(screen.getByText("Chat")).toBeTruthy();
});

test("back pops a deep-linked chat to the Chats list", () => {
  const { router } = renderPhone(phoneClient(), "/c/bot:dev");
  const nav = document.querySelector(".chatnav") as HTMLElement;
  // The back button is a chevron circle; its title stays its accessible name.
  fireEvent.click(within(nav).getByRole("button", { name: "Chats" }));
  expect(router.state.location.pathname).toBe("/");
});

test("a render bug in a phone screen says Something went wrong, keeps the tab bar", async () => {
  const Boom = (): never => {
    throw new Error("boom");
  };
  const router = createMemoryRouter(
    [{ path: "*", element: <PhoneShell routes={[{ path: "/", element: <Boom /> }]} /> }],
    { initialEntries: ["/"] },
  );
  render(
    <QueryClientProvider client={phoneClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Something went wrong.")).toBeTruthy();
  expect(tabbar()).toBeTruthy();
});

/** Drag from x0 by dx on the root of a pushed chat. */
function drag(x0: number, dx: number) {
  const root = document.querySelector(".ios") as HTMLElement;
  fireEvent.pointerDown(root, { clientX: x0, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(root, { clientX: x0 + dx, clientY: 300, pointerId: 1 });
  return root;
}

test("edge swipe: the top view follows the finger, a release past a third pops", () => {
  const { router } = renderPhone(phoneClient(), "/c/bot:dev");
  const root = drag(10, 100);
  const top = [...root.querySelectorAll<HTMLElement>(".ios-view")].at(-1) as HTMLElement;
  expect(top.style.transform).toBe("translateX(100px)");
  expect(top.className).toContain("dragging");
  fireEvent.pointerUp(root, { clientX: 110, pointerId: 1 });
  expect(router.state.location.pathname).toBe("/c/bot:dev");
  expect(top.style.transform).toBe("");
  drag(10, 200);
  fireEvent.pointerUp(root, { clientX: 210, pointerId: 1 });
  expect(router.state.location.pathname).toBe("/");
});

test("a drag that starts away from the edge does nothing", () => {
  renderPhone(phoneClient(), "/c/bot:dev");
  const root = drag(100, 200);
  const top = [...root.querySelectorAll<HTMLElement>(".ios-view")].at(-1) as HTMLElement;
  expect(top.style.transform).toBe("");
});

test("a vertical-first move cancels the swipe", () => {
  renderPhone(phoneClient(), "/c/bot:dev");
  const root = document.querySelector(".ios") as HTMLElement;
  fireEvent.pointerDown(root, { clientX: 10, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(root, { clientX: 14, clientY: 330, pointerId: 1 });
  fireEvent.pointerMove(root, { clientX: 300, clientY: 332, pointerId: 1 });
  const top = [...root.querySelectorAll<HTMLElement>(".ios-view")].at(-1) as HTMLElement;
  expect(top.style.transform).toBe("");
  expect(top.className).not.toContain("dragging");
});

test("a pointercancel never pops, even past a third", () => {
  const { router } = renderPhone(phoneClient(), "/c/bot:dev");
  const root = drag(10, 220);
  fireEvent.pointerCancel(root, { pointerId: 1 });
  expect(router.state.location.pathname).toBe("/c/bot:dev");
});
