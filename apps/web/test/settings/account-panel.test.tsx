import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(),
  add: vi.fn(),
  revoke: vi.fn(),
  getSession: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../../src/api/auth-client", () => ({
  authClient: {
    getSession: mocks.getSession,
    revokeSessions: mocks.revoke,
    passkey: {
      listUserPasskeys: mocks.list,
      deletePasskey: mocks.del,
      addPasskey: mocks.add,
    },
  },
}));
vi.mock("../../src/components/shell/use-app-navigate", () => ({
  useAppNavigate: () => mocks.navigate,
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountPanel } from "../../src/components/settings/account-panel";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ data: { user: { email: "owner@example.com" } } });
  mocks.list.mockResolvedValue({
    data: [
      { id: "p1", name: "Laptop", createdAt: "2026-10-24T10:00:00Z" },
      { id: "p2", name: "Phone", createdAt: "2026-10-24T11:00:00Z" },
    ],
  });
  mocks.del.mockResolvedValue({ data: { status: true } });
  mocks.revoke.mockResolvedValue({ data: { status: true } });
});

function setup() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <AccountPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("lists the passkeys and the signed-in email", async () => {
  setup();
  expect(await screen.findByText("Laptop")).toBeTruthy();
  expect(screen.getByText("Phone")).toBeTruthy();
  expect(await screen.findByText("owner@example.com")).toBeTruthy();
});

test("Remove deletes that passkey", async () => {
  setup();
  await screen.findByText("Phone");
  await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[1] as HTMLElement);
  await waitFor(() => expect(mocks.del).toHaveBeenCalledWith({ id: "p2" }));
});

test("Add passkey calls addPasskey", async () => {
  mocks.add.mockResolvedValue({ data: {} });
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Add passkey" }));
  await waitFor(() => expect(mocks.add).toHaveBeenCalled());
});

test("Sign out all devices revokes sessions and goes to /login", async () => {
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "Sign out all" }));
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalled());
  await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
});
