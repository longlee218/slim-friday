import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { ActivityCapsule, tickerItems } from "../../src/components/shell/activity-capsule";
import { notifyToast } from "../../src/components/shell/notification-toast";
import { approval, bot, seededClient, status } from "./fixtures";

const { stop, toast } = vi.hoisted(() => ({
  stop: vi.fn(),
  toast: Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { control: { stop } },
}));

const Path = () => <output data-testid="path">{useLocation().pathname}</output>;

function renderCapsule(seed: Parameters<typeof seededClient>[0]) {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <ActivityCapsule />
            <Path />
          </>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(
    <QueryClientProvider client={seededClient({ bots: [bot("dev", "Dev")], ...seed })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1200;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

test("ticker items", () => {
  expect(tickerItems([status("dev", "Dev", true, "Running test suite")], 2)).toEqual([
    "Dev: running test suite",
    "2 approvals waiting for you",
  ]);
  expect(tickerItems([status("dev", "Dev", false)], 1)).toEqual(["1 approval waiting for you"]);
  expect(tickerItems([], 0)).toEqual([]);
});

test("capsule idle says All quiet and $0.00", () => {
  renderCapsule({});
  expect(screen.getByText("All quiet")).toBeTruthy();
  expect(screen.getByText("$0.00")).toBeTruthy();
  expect(document.querySelector(".cap-badge, .badge")).toBeNull();
});

test("capsule shows the ticker, summed cost and the approvals badge", () => {
  renderCapsule({
    status: [
      status("dev", "Dev", true, "Running tests", 1.5),
      status("ray", "Ray", false, "", 0.34),
    ],
    approvals: [approval("a1", "dev"), approval("a2", "dev")],
  });
  expect(screen.getByText("Dev: running tests")).toBeTruthy();
  expect(screen.getByText("$1.84")).toBeTruthy();
  expect(screen.getByText("2").className).toContain("amber");
});

test("popover lists working bots, waiting cards and Open Activity", async () => {
  renderCapsule({
    status: [status("dev", "Dev", true, "Running tests", 1.84)],
    approvals: [approval("a1", "dev", { expiresAt: Date.now() + 125_000 })],
  });
  await userEvent.click(screen.getByRole("button", { name: "Activity" }));
  expect(await screen.findByText("Working now")).toBeTruthy();
  expect(screen.getByText("$1.84 today")).toBeTruthy();
  expect(screen.getByText("Waiting for you")).toBeTruthy();
  expect(screen.getByText("Bash · git push")).toBeTruthy();
  expect(screen.getByText(/Dev · Auto-denies in 2:0\d/)).toBeTruthy();
  expect(screen.getByText("⌘3")).toBeTruthy();
  await userEvent.click(screen.getByText("Review"));
  expect(screen.getByTestId("path").textContent).toBe("/c/bot:dev");
});

test("popover without working bots", async () => {
  renderCapsule({});
  await userEvent.click(screen.getByRole("button", { name: "Activity" }));
  expect(await screen.findByText("No bot is working.")).toBeTruthy();
  await userEvent.click(screen.getByText("Open Activity"));
  expect(screen.getByTestId("path").textContent).toBe("/ops");
});

test("popover Stop calls control.stop and toasts", async () => {
  stop.mockResolvedValue({ stopped: 1 });
  renderCapsule({ status: [status("dev", "Dev", true, "Running tests")] });
  await userEvent.click(screen.getByRole("button", { name: "Activity" }));
  await userEvent.click(await screen.findByRole("button", { name: "Stop Dev" }));
  expect(stop).toHaveBeenCalledWith({ botId: "dev" });
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith("Stopped. Background tasks were cancelled."),
  );
  const open = await screen.findByRole("button", { name: "Open chat" });
  await userEvent.click(open);
  expect(screen.getByTestId("path").textContent).toBe("/c/bot:dev");
});

test("notifyToast: desktop only, text cut to 90, click opens the chat", async () => {
  const open = vi.fn();
  notifyToast(
    { conversationId: "bot:dev", botId: "dev", title: "Dev", text: "x".repeat(120) },
    open,
  );
  expect(toast.custom).toHaveBeenCalledTimes(1);
  const [render_, opts] = toast.custom.mock.calls[0] as [(id: string) => React.ReactNode, object];
  expect(opts).toMatchObject({ duration: 3600 });
  const view = render(<>{render_("t1")}</>);
  expect(within(view.container).getByText("Dev")).toBeTruthy();
  expect(within(view.container).getByText("x".repeat(90)).textContent).toHaveLength(90);
  await userEvent.click(view.container.querySelector("button") as HTMLElement);
  expect(open).toHaveBeenCalledWith("bot:dev");

  toast.custom.mockClear();
  window.innerWidth = 400;
  notifyToast({ conversationId: "bot:dev", title: "Dev", text: "hi" }, open);
  expect(toast.custom).not.toHaveBeenCalled();
});
