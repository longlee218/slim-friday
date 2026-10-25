import type { McpServerDto } from "@friday/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../../src/api/client";
import { McpDetail } from "../../../src/components/settings/mcp/mcp-detail";
import { McpList } from "../../../src/components/settings/mcp/mcp-list";
import { applyEffects } from "../../../src/events/apply-effects";
import { reduceEvent } from "../../../src/events/event-reducer";
import { seededClient } from "../../shell/fixtures";

const api = vi.hoisted(() => ({ test: vi.fn(), signIn: vi.fn() }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../../src/api/client")>()),
  client: { config: { mcp: { test: api.test, signIn: api.signIn } } },
}));

const oauthServer = (auth?: McpServerDto["auth"], shipped = false): McpServerDto => ({
  type: "http",
  name: "db",
  url: "https://db-mcp.example.com/mcp",
  oauth: {},
  auth,
  shipped,
  usedBy: [],
});

/** Shows the router's location so a test can read the search string. */
function Where() {
  return <div data-testid="where">{useLocation().search}</div>;
}

function setup(server: McpServerDto, search = "", path = `/settings/mcp/${server.name}`) {
  const qc = seededClient({});
  qc.setQueryData(orpc.config.mcp.list.queryKey(), [server]);
  qc.setQueryData(
    orpc.config.mcp.calls.queryKey({ input: { server: server.name, limit: 20 } }),
    [],
  );
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`${path}${search}`]}>
        <Routes>
          <Route path="/settings/mcp/:name" element={<McpDetail />} />
          <Route path="/settings/mcp" element={<McpList />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  api.test.mockResolvedValue({ state: "needs_auth", message: "Sign in first." });
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

test("needs_login banner shows the Sign in button", async () => {
  setup(oauthServer({ status: "needs_login" }));
  expect(await screen.findByText("Needs sign-in")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
});

test("connected: one banner with tools and last refresh, Sign in again is secondary", async () => {
  api.test.mockResolvedValue({ state: "connected", tools: ["a", "b"] });
  setup(oauthServer({ status: "connected", lastRefreshAt: Date.now() - 3 * 3600_000 }));
  // The text is split by a <b>, so match the banner's own text content.
  const banner = await screen.findByText(
    (_, el) =>
      !!el?.classList.contains("grow") &&
      el.textContent === "Signed in · 2 tools · refreshed 3h ago",
  );
  expect(banner).toBeTruthy();
  // The probe's own green banner is not repeated.
  expect(document.querySelectorAll(".conn.ok")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Test again" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in again" }).classList).not.toContain("primary");
});

test("a failed test still shows its error under the sign-in banner", async () => {
  api.test.mockResolvedValue({ state: "error", message: "upstream 502" });
  setup(oauthServer({ status: "connected" }));
  expect(await screen.findByText("upstream 502")).toBeTruthy();
});

test("Sign in calls signIn and navigates to the returned url", async () => {
  api.signIn.mockResolvedValue({ url: "https://auth.example.com/authorize?x=1" });
  setup(oauthServer({ status: "never" }));
  expect(await screen.findByText("Not signed in")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith("https://auth.example.com/authorize?x=1"),
  );
  expect(api.signIn).toHaveBeenCalledWith({ name: "db" });
});

test("a shipped OAuth server is read only but keeps Sign in", async () => {
  setup(oauthServer({ status: "needs_login" }, true));
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
});

test("signin=ok shows a toast and clears the param", async () => {
  setup(oauthServer({ status: "connected" }), "?signin=ok");
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Signed in to db"));
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
});

test("a failure lands on the list: toast and cleared param there", async () => {
  setup(oauthServer({ status: "never" }), "?signin=expired", "/settings/mcp");
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("The sign-in link expired, try again"),
  );
  await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(""));
});

test("the unsaved-edits hint shows after editing the URL or OAuth, not on a clean form", async () => {
  setup(oauthServer({ status: "connected" }));
  const hint = () => screen.queryByText("Test and sign-in use the saved settings.");
  const signIn = () => screen.getByRole("button", { name: "Sign in again" }) as HTMLButtonElement;
  await screen.findByText("Signed in");
  expect(hint()).toBeNull();
  expect(signIn().disabled).toBe(false);
  await userEvent.type(screen.getByLabelText("URL"), "x");
  expect(hint()).toBeTruthy();
  expect(signIn().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText("URL"), "{Backspace}");
  expect(hint()).toBeNull();
  await userEvent.click(screen.getByRole("switch", { name: "Sign in with OAuth" }));
  expect(hint()).toBeTruthy();
});

test("signin=denied shows an error toast", async () => {
  setup(oauthServer({ status: "never" }), "?signin=denied");
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sign-in was cancelled"));
});

test("mcp.auth needs_login invalidates the list and toasts once", () => {
  const qc = seededClient({});
  const spy = vi.spyOn(qc, "invalidateQueries");
  const fx = reduceEvent(
    { type: "mcp.auth", server: "db", status: "needs_login" },
    { activeConversationId: null, visible: true, now: 1 },
  );
  applyEffects(qc, fx, vi.fn());
  expect(spy).toHaveBeenCalledWith({ queryKey: orpc.config.mcp.key() });
  expect(toast).toHaveBeenCalledTimes(1);
  expect(String(toast.mock.calls[0]?.[0])).toBe("db needs sign-in");
});
