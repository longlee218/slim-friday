import type { FridayEvent, MessageDto } from "@friday/contracts";
import { withEventMeta } from "@orpc/client";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { client } from "../../src/api/client";
import { messagesKey } from "../../src/events/apply-messages";
import { nextBackoff } from "../../src/events/backoff";
import { type ConnectionState, useEventStream } from "../../src/events/use-event-stream";
import { botMsg } from "./fixtures";

type Subscribe = typeof client.events.subscribe;
type Input = { lastEventId?: number };

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const page0 = () =>
  qc.getQueryData<InfiniteData<MessageDto[]>>(messagesKey("bot:dev"))?.pages[0] ?? [];
const evt = (e: FridayEvent, id: number) => withEventMeta(e, { id: String(id) });
const msg = (id: number): FridayEvent => ({
  type: "message",
  conversationId: "bot:dev",
  message: botMsg("dev", id),
});
/** An open stream that yields nothing and throws when aborted, like a real fetch. */
async function* hang(signal?: AbortSignal): AsyncGenerator<FridayEvent> {
  await new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(new Error("aborted"))),
  );
}
/** A stream that fails at once. */
function dropping(): AsyncGenerator<FridayEvent> {
  return (async function* () {
    yield* [] as FridayEvent[];
    throw new Error("drop");
  })();
}
/** Fake subscribe: each call runs the next script (an async generator body). */
function fake(scripts: Array<() => AsyncGenerator<FridayEvent>>) {
  const calls: Input[] = [];
  const subscribe = (async (input: Input, o?: { signal?: AbortSignal }) => {
    calls.push(input);
    return scripts[calls.length - 1]?.() ?? hang(o?.signal);
  }) as unknown as Subscribe;
  return { calls, subscribe };
}
/** Instant sleep that still yields to the event loop. */
const sleep = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData<InfiniteData<MessageDto[]>>(messagesKey("bot:dev"), {
    pages: [[]],
    pageParams: [undefined],
  });
});
afterEach(() => vi.restoreAllMocks());

test("nextBackoff doubles and caps at 30s", () => {
  expect([0, 1, 2, 5, 9].map(nextBackoff)).toEqual([1000, 2000, 4000, 30000, 30000]);
});

test("reconnects with lastEventId and does not duplicate", async () => {
  const { calls, subscribe } = fake([
    async function* () {
      yield evt({ type: "config.changed" }, 1);
      yield evt(msg(7), 2);
      throw new Error("drop");
    },
    async function* () {
      yield evt(msg(7), 2);
      yield* hang();
    },
  ]);
  renderHook(
    () => useEventStream({ activeConversationId: null, notify: () => {}, subscribe, sleep }),
    {
      wrapper,
    },
  );
  await waitFor(() => expect(calls).toHaveLength(2));
  await waitFor(() => expect(page0().filter((m) => m.id === 7)).toHaveLength(1));
  expect(calls[0]).toEqual({});
  expect(calls[1]?.lastEventId).toBe(2);
});

test("state goes reconnecting then live", async () => {
  const states: ConnectionState[] = [];
  const { subscribe } = fake([
    dropping,
    async function* () {
      yield evt({ type: "config.changed" }, 5);
      yield* hang();
    },
  ]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowSleep = () => gate;
  const { result } = renderHook(
    () => {
      const s = useEventStream({
        activeConversationId: null,
        notify: () => {},
        subscribe,
        sleep: slowSleep,
      });
      states.push(s);
      return s;
    },
    { wrapper },
  );
  await waitFor(() => expect(result.current).toBe("reconnecting"));
  release();
  await waitFor(() => expect(result.current).toBe("live"));
  expect(states).toContain("reconnecting");
});

test("resync refetches active queries", async () => {
  const spy = vi.spyOn(qc, "refetchQueries").mockResolvedValue();
  const { subscribe } = fake([
    async function* () {
      yield evt({ type: "resync" }, 3);
      yield* hang();
    },
  ]);
  const { result } = renderHook(
    () => useEventStream({ activeConversationId: null, notify: () => {}, subscribe, sleep }),
    { wrapper },
  );
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  expect(spy).toHaveBeenCalledWith({ type: "active" });
  await waitFor(() => expect(result.current).not.toBe("resyncing"));
});

test("changing the active conversation does not restart the stream", async () => {
  const { calls, subscribe } = fake([]);
  const { rerender } = renderHook(
    ({ id }) => useEventStream({ activeConversationId: id, notify: () => {}, subscribe, sleep }),
    { wrapper, initialProps: { id: "a" as string | null } },
  );
  await waitFor(() => expect(calls).toHaveLength(1));
  rerender({ id: "b" });
  await sleep();
  expect(calls).toHaveLength(1);
});

test("offline shows offline and online reconnects immediately", async () => {
  const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const { calls, subscribe } = fake([]);
  const { result } = renderHook(
    () => useEventStream({ activeConversationId: null, notify: () => {}, subscribe }),
    { wrapper },
  );
  await waitFor(() => expect(calls).toHaveLength(1));
  onLine.mockReturnValue(false);
  act(() => void window.dispatchEvent(new Event("offline")));
  await waitFor(() => expect(result.current).toBe("offline"));
  onLine.mockReturnValue(true);
  act(() => void window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(calls).toHaveLength(2));
});

test("unmount aborts the backoff sleep and stops the loop", async () => {
  const { calls, subscribe } = fake([dropping]);
  let slept: AbortSignal | undefined;
  const sleepSpy = (_ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      slept = signal;
      signal?.addEventListener("abort", () => resolve());
    });
  const { unmount } = renderHook(
    () =>
      useEventStream({ activeConversationId: null, notify: () => {}, subscribe, sleep: sleepSpy }),
    { wrapper },
  );
  await waitFor(() => expect(slept).toBeDefined());
  unmount();
  await sleep();
  expect(slept?.aborted).toBe(true);
  expect(calls).toHaveLength(1);
});
