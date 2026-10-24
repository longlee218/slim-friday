import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useReducedMotion, useWidth } from "../../src/lib/use-media";

test("useWidth follows resize and unsubscribes on unmount", () => {
  const remove = vi.spyOn(window, "removeEventListener");
  const { result, unmount } = renderHook(() => useWidth());
  act(() => {
    window.innerWidth = 500;
    window.dispatchEvent(new Event("resize"));
  });
  expect(result.current).toBe(500);
  unmount();
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
});

test("useReducedMotion follows matchMedia changes", () => {
  let listener: () => void = () => {};
  const mq = {
    matches: false,
    addEventListener: (_: string, l: () => void) => {
      listener = l;
    },
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", () => mq);
  const { result, unmount } = renderHook(() => useReducedMotion());
  expect(result.current).toBe(false);
  act(() => {
    mq.matches = true;
    listener();
  });
  expect(result.current).toBe(true);
  unmount();
  expect(mq.removeEventListener).toHaveBeenCalled();
  vi.unstubAllGlobals();
});
