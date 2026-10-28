import type { ComputerStatusDto } from "@friday/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { ComputerCard } from "../../src/components/computer/computer-card";
import {
  PanelsContext,
  type ResponsivePanels,
} from "../../src/components/shell/use-responsive-panels";

const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  closeView: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { computer: { view: mocks.view, closeView: mocks.closeView } },
}));

const status = (over: Partial<ComputerStatusDto> = {}): ComputerStatusDto => ({
  computer: "desk",
  running: true,
  slots: { used: 1, limit: 2, text: "1 of 2 computers in use" },
  control: { holder: "none" },
  ...over,
});

function mount(s: ComputerStatusDto = status()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(orpc.computer.status.queryKey({ input: { botId: "dev" } }), s);
  const setInspectorWide = vi.fn();
  const panels = { inspectorWide: false, setInspectorWide } as unknown as ResponsivePanels;
  render(
    <QueryClientProvider client={qc}>
      <PanelsContext.Provider value={panels}>
        <ComputerCard botId="dev" botName="Dev" />
      </PanelsContext.Provider>
    </QueryClientProvider>,
  );
  return { setInspectorWide };
}

const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.view.mockResolvedValue({ url: "/computer-view/tok/", expiresAt: 9e12 });
  mocks.closeView.mockResolvedValue({ ok: true });
});

test("a live thumbnail offers Open, which widens the inspector", async () => {
  const { setInspectorWide } = mount();
  await press("Watch live");
  expect(document.querySelector("iframe")?.getAttribute("src")).toBe("/computer-view/tok/");
  await press("Open");
  expect(setInspectorWide).toHaveBeenCalledWith(true);
});

test("a failed link shows its reason in the screen with Retry, not a toast", async () => {
  mocks.view.mockRejectedValueOnce(new Error('Computer "desk" is not running; nothing to view.'));
  mount();
  await press("Watch live");
  expect(screen.getByRole("alert").textContent).toContain("is not running");
  expect(mocks.toast.error).not.toHaveBeenCalled();
  await press("Retry");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector("iframe")).toBeTruthy();
});

test("a stopped computer says so and offers nothing to watch", () => {
  mount(status({ running: false }));
  expect(screen.getByText("Computer is off")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Watch live" })).toBeNull();
});
