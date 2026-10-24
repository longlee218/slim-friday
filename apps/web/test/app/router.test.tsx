import { ORPCError } from "@orpc/client";
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

vi.mock("../../src/events/use-event-stream", () => ({ useEventStream: () => "live" }));

import { QueryClientProvider } from "@tanstack/react-query";
import { handleUnauthorized } from "../../src/api/client";
import { appRoutes, wireUnauthorized } from "../../src/app/router";
import { navHistory } from "../../src/components/shell/nav-history";
import { seededClient } from "../shell/fixtures";

/** The app inside a client whose lists are seeded (no network). */
function renderApp(router: ReturnType<typeof createMemoryRouter>) {
  return render(
    <QueryClientProvider client={seededClient({})}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  window.innerWidth = 1200;
  navHistory.reset("/");
});

test("protected route without a session redirects to /login", async () => {
  mocks.getSession.mockResolvedValue({ data: null });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/c/bot:dev"] });
  render(<RouterProvider router={router} />);
  expect(await screen.findByText("Sign in to Friday")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
});

test("on desktop / redirects to the last visited chat (default: Friday)", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
  renderApp(router);
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/c/bot:friday"));
  expect(document.querySelector(".mac")).toBeTruthy();
});

test("on the phone / renders the Chats list", async () => {
  window.innerWidth = 390;
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
  renderApp(router);
  expect((await screen.findAllByText("Chats")).length).toBeGreaterThan(0);
  expect(router.state.location.pathname).toBe("/");
  expect(document.querySelector(".tabbar")).toBeTruthy();
});

test("/login while signed in goes to /; a failed session check stays on /login", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const signedIn = createMemoryRouter(appRoutes, { initialEntries: ["/login"] });
  const first = renderApp(signedIn);
  await vi.waitFor(() => expect(signedIn.state.location.pathname).not.toBe("/login"));
  first.unmount();
  mocks.getSession.mockRejectedValue(new Error("network"));
  const offline = createMemoryRouter(appRoutes, { initialEntries: ["/login"] });
  renderApp(offline);
  expect(await screen.findByText("Sign in to Friday")).toBeTruthy();
  expect(offline.state.location.pathname).toBe("/login");
});

test("/login?expired=1 stays on the sign-in screen even if the session still reads valid", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/login?expired=1"] });
  renderApp(router);
  expect(await screen.findByText("Sign in to Friday")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/login");
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
    const { unmount } = renderApp(router);
    expect(await screen.findByText(`${title} is not built yet.`)).toBeTruthy();
    unmount();
  }
});

test("unauthorized rpc sends the owner to /login", async () => {
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/ops"] });
  renderApp(router);
  await screen.findByText("Ops is not built yet.");
  wireUnauthorized(router);
  // The session is gone, so the sign-in screen stays.
  mocks.getSession.mockResolvedValue({ data: null });
  handleUnauthorized(new ORPCError("UNAUTHORIZED"));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  expect(router.state.location.search).toBe("?expired=1");
});

test("a 502 from the session check (tunnel error page) shows Can't reach Friday, not sign-in", async () => {
  mocks.getSession.mockResolvedValue({ data: null, error: { status: 502, statusText: "" } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/ops"] });
  renderApp(router);
  expect(await screen.findByText("Can't reach Friday.")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/ops");
});

test("a 401 from the session check goes to sign-in", async () => {
  mocks.getSession.mockResolvedValue({ data: null, error: { status: 401, statusText: "" } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/ops"] });
  renderApp(router);
  expect(await screen.findByText("Sign in to Friday")).toBeTruthy();
});

test("an unreachable API shows Can't reach Friday and Retry loads the route", async () => {
  mocks.getSession.mockRejectedValueOnce(new Error("network"));
  mocks.getSession.mockResolvedValue({ data: { user: { id: "u" } } });
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/ops"] });
  renderApp(router);
  expect(await screen.findByText("Can't reach Friday.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Ops is not built yet.")).toBeTruthy();
});
