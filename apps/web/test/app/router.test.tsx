import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
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

import { handleUnauthorized } from "../../src/api/client";
import { appRoutes, wireUnauthorized } from "../../src/app/router";

beforeEach(() => vi.resetAllMocks());

test("protected route without a session redirects to /login", async () => {
  mocks.getSession.mockResolvedValue({ data: null });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/c/bot:dev"] });
  render(<RouterProvider router={router} />);
  expect(await screen.findByText("Sign in to Friday")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
});

test("a session opens the chat route and / redirects to the Friday chat", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  expect(await screen.findByText("Chat is not built yet.")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/c/bot:friday");
});

test("every contract path is routed (placeholder pages)", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  for (const [path, title] of [
    ["/tickets", "Tickets"],
    ["/tickets/FRI-1", "Ticket"],
    ["/ops", "Ops"],
    ["/settings/bot/dev/tools", "Settings"],
  ]) {
    const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
    const { unmount } = render(<RouterProvider router={router} />);
    expect(await screen.findByText(`${title} is not built yet.`)).toBeTruthy();
    unmount();
  }
});

test("unauthorized rpc sends the owner to /login", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/ops"] });
  render(<RouterProvider router={router} />);
  await screen.findByText("Ops is not built yet.");
  wireUnauthorized(router);
  handleUnauthorized(new ORPCError("UNAUTHORIZED"));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/login"));
});
