import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStopRun } from "../../src/components/shell/use-stop-run";
import { resetStatusDebounce } from "../../src/events/apply-effects";
import { startRun } from "../../src/events/apply-runs";
import { liveRunKey } from "../../src/events/client-keys";

const { stop, toast } = vi.hoisted(() => ({ stop: vi.fn(), toast: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { control: { stop } },
}));

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const runs = (c: string) => Object.keys(qc.getQueryData<object>(liveRunKey(c)) ?? {});

beforeEach(() => {
  qc = new QueryClient();
  stop.mockReset();
  startRun(qc, "bot:dev", "dev", 1);
  startRun(qc, "group:crew", "dev", 1);
  startRun(qc, "group:crew", "pia", 1);
});
afterEach(() => resetStatusDebounce(qc));

test("stopping a bot ends its runs everywhere at once", async () => {
  stop.mockResolvedValue({});
  const { result } = renderHook(() => useStopRun(), { wrapper });
  await result.current({ botId: "dev" });
  expect(runs("bot:dev")).toEqual([]);
  expect(runs("group:crew")).toEqual(["pia"]);
});

test("stopping a conversation ends every run in it", async () => {
  stop.mockResolvedValue({});
  const { result } = renderHook(() => useStopRun(), { wrapper });
  await result.current({ conversationId: "group:crew" });
  expect(runs("group:crew")).toEqual([]);
  expect(runs("bot:dev")).toEqual(["dev"]);
});

test("a failed stop keeps the runs", async () => {
  stop.mockRejectedValue(new Error("down"));
  const { result } = renderHook(() => useStopRun(), { wrapper });
  await result.current({ botId: "dev" });
  expect(runs("bot:dev")).toEqual(["dev"]);
  expect(toast).toHaveBeenCalledWith("Could not stop. Try again.");
});
