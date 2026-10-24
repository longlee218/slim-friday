import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  passkey: vi.fn(),
  magicLink: vi.fn(),
  addPasskey: vi.fn(),
}));
vi.mock("../../src/api/auth-client", () => ({
  authClient: {
    getSession: mocks.getSession,
    signIn: { passkey: mocks.passkey, magicLink: mocks.magicLink },
    passkey: { addPasskey: mocks.addPasskey },
  },
}));

import { appRoutes } from "../../src/app/router";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
});

function open(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

test("passkey button calls signIn.passkey and opens / on success", async () => {
  mocks.passkey.mockResolvedValue({ data: {}, error: null });
  const router = open("/login");
  await userEvent.click(await screen.findByRole("button", { name: /Sign in with passkey/ }));
  expect(mocks.passkey).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/c/bot:friday"));
});

test("a failed passkey shows the failure line and stays on /login", async () => {
  mocks.passkey.mockResolvedValue({ data: null, error: { message: "cancelled" } });
  const router = open("/login");
  await userEvent.click(await screen.findByRole("button", { name: /Sign in with passkey/ }));
  expect(
    await screen.findByText("That didn't work. Try again or get a sign-in link."),
  ).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
});

test("Send link stays disabled until an email is typed", async () => {
  open("/login-link");
  const send = await screen.findByRole("button", { name: "Send link" });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("Your email"), "owner@example.test");
  expect((send as HTMLButtonElement).disabled).toBe(false);
});

test("Send link calls magicLink with the setup callback and shows the host log line", async () => {
  mocks.magicLink.mockResolvedValue({ data: { status: true }, error: null });
  open("/login-link");
  await userEvent.type(await screen.findByLabelText("Your email"), "owner@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Send link" }));
  expect(await screen.findByText("tail -n 1 ~/.friday/logs/owner-links.log")).toBeTruthy();
  expect(mocks.magicLink).toHaveBeenCalledWith({
    email: "owner@example.test",
    callbackURL: `${location.origin}/setup-passkey`,
  });
});

test("Create passkey calls addPasskey and opens /welcome", async () => {
  mocks.addPasskey.mockResolvedValue({ data: {}, error: null });
  const router = open("/setup-passkey");
  await userEvent.click(await screen.findByRole("button", { name: /Create passkey/ }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/welcome"));
  expect(await screen.findByText("You're in")).toBeTruthy();
});
