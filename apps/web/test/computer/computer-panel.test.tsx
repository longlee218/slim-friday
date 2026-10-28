import type { ComputerStatusDto } from "@friday/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { orpc } from "../../src/api/client";
import { ComputerPanel } from "../../src/components/computer/computer-panel";

const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  takeControl: vi.fn(),
  renewControl: vi.fn(),
  giveBack: vi.fn(),
  closeView: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: {
    computer: {
      view: mocks.view,
      takeControl: mocks.takeControl,
      renewControl: mocks.renewControl,
      giveBack: mocks.giveBack,
      closeView: mocks.closeView,
    },
  },
}));

const status = (over: Partial<ComputerStatusDto> = {}): ComputerStatusDto => ({
  computer: "desk",
  running: true,
  slots: { used: 1, limit: 2, text: "1 of 2 computers in use" },
  control: { holder: "none" },
  ...over,
});

function mountWithClient(s: ComputerStatusDto = status()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(orpc.computer.status.queryKey({ input: { botId: "dev" } }), s);
  const view = render(
    <QueryClientProvider client={qc}>
      <ComputerPanel botId="dev" botName="Dev" />
    </QueryClientProvider>,
  );
  return { qc, view };
}
const mount = (s?: ComputerStatusDto) => mountWithClient(s).view;

const frame = () => document.querySelector("iframe");
const press = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.view.mockImplementation(async ({ mode }: { mode: string }) => ({
    url: `/computer-view/${mode}-tok/`,
    expiresAt: 9e12,
  }));
  mocks.takeControl.mockResolvedValue({ expiresAt: 9e12 });
  mocks.renewControl.mockResolvedValue({ ok: true });
  mocks.giveBack.mockResolvedValue({ ok: true });
  mocks.closeView.mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

test("no stream element exists until View is pressed, then the iframe points at the view path", async () => {
  mount();
  expect(screen.getByText("Nothing is streaming.")).toBeTruthy();
  expect(screen.getByText("1 of 2 computers in use")).toBeTruthy();
  expect(frame()).toBeNull();
  await press("View");
  expect(mocks.view).toHaveBeenCalledWith({ botId: "dev", mode: "view" });
  expect(frame()?.getAttribute("src")).toBe("/computer-view/view-tok/");
  expect(frame()?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
});

test("a stopped computer says it is off and does not offer a stream", () => {
  mount(status({ running: false }));
  expect(screen.getByText("Computer is off.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "View" })).toBeNull();
});

test("Take control reloads a control frame and renews every 10 s; Give back stops renewing", async () => {
  mount();
  await press("View");
  await press("Take control");
  expect(frame()?.getAttribute("src")).toBe("/computer-view/control-tok/");
  expect(screen.getByText("Dev is waiting and resumes when you give back")).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(mocks.renewControl).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(mocks.renewControl).toHaveBeenCalledTimes(2);
  await press("Give back");
  expect(mocks.giveBack).toHaveBeenCalledWith({ botId: "dev" });
  expect(frame()?.getAttribute("src")).toBe("/computer-view/view-tok/");
  expect(screen.queryByText("Dev is waiting and resumes when you give back")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.renewControl).toHaveBeenCalledTimes(2);
});

test("Take control shows the waiting line while the bot finishes its step", async () => {
  let release: (v: { expiresAt: number }) => void = () => {};
  mocks.takeControl.mockReturnValue(new Promise((r) => (release = r)));
  mount();
  await press("View");
  await press("Take control");
  expect(screen.getByText("Waiting for the bot to finish its step…")).toBeTruthy();
  await act(async () => release({ expiresAt: 9e12 }));
  expect(screen.queryByText("Waiting for the bot to finish its step…")).toBeNull();
});

test("a failed renew shows control lost and returns the button to Take control", async () => {
  mount();
  await press("View");
  await press("Take control");
  mocks.renewControl.mockResolvedValue({ ok: false });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByText("Control lost: connection dropped.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Take control" })).toBeTruthy();
  expect(frame()?.getAttribute("src")).toBe("/computer-view/view-tok/");
});

test("pagehide gives control back", async () => {
  mount();
  await press("View");
  await press("Take control");
  fireEvent(window, new Event("pagehide"));
  expect(mocks.giveBack).toHaveBeenCalledWith({ botId: "dev" });
});

test("Close gives back first when holding control, then closes the view", async () => {
  mount();
  await press("View");
  await press("Take control");
  await press("Close");
  expect(mocks.giveBack).toHaveBeenCalledTimes(1);
  expect(mocks.closeView).toHaveBeenCalledWith({ botId: "dev" });
  expect(mocks.giveBack.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.closeView.mock.invocationCallOrder[0] as number,
  );
  expect(frame()).toBeNull();
});

test("after 10 s without a signal an honest new-tab link appears and the iframe stays", async () => {
  mount();
  await press("View");
  await act(() => vi.advanceTimersByTimeAsync(9_000));
  expect(screen.queryByText("Not showing?", { exact: false })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  const link = screen.getByRole("link", { name: "Open the viewer in a new tab" });
  expect(link.getAttribute("href")).toBe("/computer-view/view-tok/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener");
  expect(frame()).not.toBeNull();
  expect(screen.queryByText("This device cannot play the stream.")).toBeNull();
});

test("the status query polls every 10 s while the panel is mounted", () => {
  const { qc } = mountWithClient();
  const query = qc.getQueryCache().find({
    queryKey: orpc.computer.status.queryKey({ input: { botId: "dev" } }),
  });
  expect(query?.observers[0]?.options.refetchInterval).toBe(10_000);
});
