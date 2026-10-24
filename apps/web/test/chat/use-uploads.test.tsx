import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useUploads } from "../../src/components/chat/use-uploads";

const mocks = vi.hoisted(() => ({ uploadCreate: vi.fn() }));
vi.mock("../../src/api/client", async (orig) => ({
  ...(await orig<typeof import("../../src/api/client")>()),
  client: { chat: { uploadCreate: mocks.uploadCreate } },
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  mocks.uploadCreate.mockResolvedValue({ uploadId: "u1", putUrl: "https://r2/put" });
  fetchMock.mockResolvedValue({ ok: true });
});

const file = (name: string, type = "image/png", size = 3) =>
  new File([new Uint8Array(size)], name, { type });

test("upload refuses before any network call", () => {
  const { result } = renderHook(() => useUploads("bot:dev"));
  let err: string | null = null;
  act(() => {
    err = result.current.add(Array.from({ length: 6 }, (_, i) => file(`f${i}.png`)));
  });
  expect(err).toBe("Up to 5 files per message.");
  expect(mocks.uploadCreate).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.uploads).toEqual([]);
});

test("a 21 MB file is refused locally", () => {
  const { result } = renderHook(() => useUploads("bot:dev"));
  const big = new File(["x"], "big.mov");
  Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
  let err: string | null = null;
  act(() => {
    err = result.current.add([big]);
  });
  expect(err).toBe("big.mov is over 20 MB.");
  expect(mocks.uploadCreate).not.toHaveBeenCalled();
});

test("upload PUTs with the declared type, no cookies, and marks done", async () => {
  const { result } = renderHook(() => useUploads("bot:dev"));
  act(() => {
    result.current.add([file("a.png")]);
  });
  expect(result.current.uploads[0]?.state).toBe("uploading");
  await waitFor(() => expect(result.current.uploads[0]?.state).toBe("done"));
  expect(mocks.uploadCreate).toHaveBeenCalledWith({
    conversationId: "bot:dev",
    name: "a.png",
    type: "image/png",
    size: 3,
  });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://r2/put");
  expect(init.method).toBe("PUT");
  expect(init.headers).toEqual({ "Content-Type": "image/png" });
  expect(init.credentials).toBe("omit");
  expect(result.current.uploads[0]?.uploadId).toBe("u1");
});

test("a file without a type is declared application/octet-stream", async () => {
  const { result } = renderHook(() => useUploads("bot:dev"));
  act(() => {
    result.current.add([file("blob", "")]);
  });
  await waitFor(() => expect(result.current.uploads[0]?.state).toBe("done"));
  expect(mocks.uploadCreate.mock.calls[0]?.[0].type).toBe("application/octet-stream");
  expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({
    "Content-Type": "application/octet-stream",
  });
});

test("failed PUT marks the chip failed", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403 });
  const { result } = renderHook(() => useUploads("bot:dev"));
  act(() => {
    result.current.add([file("a.png")]);
  });
  await waitFor(() => expect(result.current.uploads[0]?.state).toBe("failed"));
  expect(result.current.uploads[0]?.error).toBe("Upload failed. Try again.");
});

test("a failed uploadCreate marks the chip failed", async () => {
  mocks.uploadCreate.mockRejectedValue(new Error("nope"));
  const { result } = renderHook(() => useUploads("bot:dev"));
  act(() => {
    result.current.add([file("a.png")]);
  });
  await waitFor(() => expect(result.current.uploads[0]?.state).toBe("failed"));
  expect(fetchMock).not.toHaveBeenCalled();
});

test("remove and unmount abort the in-flight PUT", async () => {
  const signals: AbortSignal[] = [];
  fetchMock.mockImplementation((_u: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    return new Promise(() => {});
  });
  const { result, unmount } = renderHook(() => useUploads("bot:dev"));
  act(() => {
    result.current.add([file("a.png"), file("b.png")]);
  });
  await waitFor(() => expect(signals).toHaveLength(2));
  act(() => result.current.remove(result.current.uploads[0]?.id as string));
  expect(signals[0]?.aborted).toBe(true);
  expect(result.current.uploads).toHaveLength(1);
  unmount();
  expect(signals[1]?.aborted).toBe(true);
});

test("switching conversation clears the chips and aborts the PUT", async () => {
  const signals: AbortSignal[] = [];
  fetchMock.mockImplementation((_u: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    return new Promise(() => {});
  });
  const { result, rerender } = renderHook(({ id }) => useUploads(id), {
    initialProps: { id: "bot:dev" },
  });
  act(() => {
    result.current.add([file("a.png")]);
  });
  await waitFor(() => expect(signals).toHaveLength(1));
  rerender({ id: "bot:pia" });
  expect(result.current.uploads).toEqual([]);
  expect(signals[0]?.aborted).toBe(true);
});
