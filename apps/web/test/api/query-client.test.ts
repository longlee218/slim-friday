import { afterEach, expect, test, vi } from "vitest";
import { queryClient } from "../../src/api/query-client";
import { liveRunKey, receiptsKey } from "../../src/events/client-keys";

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
});

test("client-only entries written with no observer outlive the default gcTime", async () => {
  vi.useFakeTimers();
  queryClient.setQueryData(receiptsKey(), { c1: { kind: "approval" } });
  queryClient.setQueryData(liveRunKey("bot:dev"), { dev: { botId: "dev" } });
  queryClient.setQueryData(["other"], 1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(queryClient.getQueryData(receiptsKey())).toBeDefined();
  expect(queryClient.getQueryData(liveRunKey("bot:dev"))).toBeDefined();
  // Server queries keep the default garbage collection.
  expect(queryClient.getQueryData(["other"])).toBeUndefined();
});
