import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { AddMcpSheet } from "../../../src/components/settings/mcp/add-mcp-sheet";
import { seededClient } from "../../shell/fixtures";

const api = vi.hoisted(() => ({ test: vi.fn(), save: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("../../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../../src/api/client")>()),
  client: { config: { mcp: api } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.save.mockResolvedValue({});
});

function setup() {
  render(
    <QueryClientProvider client={seededClient({})}>
      <AddMcpSheet open onOpenChange={() => {}} onAdded={() => {}} />
    </QueryClientProvider>,
  );
}

async function fillHttp() {
  await userEvent.type(screen.getByLabelText("Name"), "sentry");
  await userEvent.click(screen.getByRole("button", { name: "HTTP" }));
  await userEvent.type(screen.getByLabelText("URL"), "https://mcp.example.com/mcp");
}

const add = () => screen.getByRole("button", { name: "Add server" }) as HTMLButtonElement;
const testBtn = () => screen.getByRole("button", { name: "Test connection" });

test("Add stays disabled before a test", async () => {
  setup();
  await fillHttp();
  expect(add().disabled).toBe(true);
});

test("Add is enabled after a connected test", async () => {
  api.test.mockResolvedValue({ state: "connected", tools: ["a", "b"] });
  setup();
  await fillHttp();
  await userEvent.click(testBtn());
  await waitFor(() => expect(add().disabled).toBe(false));
  expect(screen.getByText(/Connected · 2 tools/)).toBeTruthy();
  expect(api.test).toHaveBeenCalledWith({
    name: "sentry",
    server: { type: "http", url: "https://mcp.example.com/mcp" },
  });
});

test("editing the URL disables Add again", async () => {
  api.test.mockResolvedValue({ state: "connected", tools: [] });
  setup();
  await fillHttp();
  await userEvent.click(testBtn());
  await waitFor(() => expect(add().disabled).toBe(false));
  await userEvent.type(screen.getByLabelText("URL"), "x");
  expect(add().disabled).toBe(true);
});

test("a failed test shows the error text and keeps Add disabled", async () => {
  api.test.mockResolvedValue({ state: "error", message: "needs SENTRY_TOKEN" });
  setup();
  await fillHttp();
  await userEvent.click(testBtn());
  expect(await screen.findByText("needs SENTRY_TOKEN")).toBeTruthy();
  expect(add().disabled).toBe(true);
});

test("a literal secret in a header is refused by the server and shown by the field", async () => {
  api.test.mockResolvedValue({ state: "connected", tools: [] });
  api.save.mockRejectedValue({
    code: "BAD_REQUEST",
    message: "use a ${NAME} reference",
    data: { field: "headers" },
  });
  setup();
  await fillHttp();
  await userEvent.click(testBtn());
  await waitFor(() => expect(add().disabled).toBe(false));
  await userEvent.click(add());
  expect(await screen.findByText("use a ${NAME} reference")).toBeTruthy();
});

test("a refused env value is shown under the env rows", async () => {
  api.test.mockResolvedValue({ state: "connected", tools: [] });
  api.save.mockRejectedValue({
    code: "BAD_REQUEST",
    message: "env needs a reference",
    data: { field: "env" },
  });
  setup();
  await userEvent.type(screen.getByLabelText("Name"), "sentry");
  await userEvent.type(screen.getByLabelText("Command"), "npx");
  await userEvent.click(testBtn());
  await waitFor(() => expect(add().disabled).toBe(false));
  await userEvent.click(add());
  expect(await screen.findByText("env needs a reference")).toBeTruthy();
});

test("an OAuth server can be added without a test", async () => {
  api.save.mockResolvedValue({});
  setup();
  await fillHttp();
  await userEvent.click(screen.getByRole("switch", { name: "Sign in with OAuth" }));
  expect((testBtn() as HTMLButtonElement).disabled).toBe(true);
  expect(add().disabled).toBe(false);
  await userEvent.click(add());
  await waitFor(() =>
    expect(api.save).toHaveBeenCalledWith({
      name: "sentry",
      server: { type: "http", url: "https://mcp.example.com/mcp", oauth: {} },
      mode: "create",
    }),
  );
});

test("switching back to a local command ends the OAuth bypass", async () => {
  setup();
  await fillHttp();
  await userEvent.click(screen.getByRole("switch", { name: "Sign in with OAuth" }));
  await userEvent.click(screen.getByRole("button", { name: "Local command" }));
  await userEvent.type(screen.getByLabelText("Command"), "npx");
  expect((testBtn() as HTMLButtonElement).disabled).toBe(false);
  expect(add().disabled).toBe(true);
  expect(screen.queryByText("Add the server, then sign in from its page.")).toBeNull();
});
