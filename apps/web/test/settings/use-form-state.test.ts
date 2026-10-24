import { ORPCError } from "@orpc/client";
import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useFormState } from "../../src/components/settings/use-form-state";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const initial = { name: "Dev", title: "" };

test("dirty follows the value and revert restores the start", () => {
  const { result } = renderHook(() => useFormState(initial));
  expect(result.current.dirty).toBe(false);
  act(() => result.current.set("title", "x"));
  expect(result.current.dirty).toBe(true);
  act(() => result.current.revert());
  expect(result.current.value).toEqual(initial);
  expect(result.current.dirty).toBe(false);
});

test("BAD_REQUEST with data.field sets that field's error; typing in it clears the error", async () => {
  const { result } = renderHook(() => useFormState(initial));
  const err = new ORPCError("BAD_REQUEST", { message: "Name taken", data: { field: "name" } });
  await act(() => result.current.submit(() => Promise.reject(err)));
  expect(result.current.errors.name).toBe("Name taken");
  expect(toast.error).not.toHaveBeenCalled();
  act(() => result.current.set("name", "Dev2"));
  expect(result.current.errors.name).toBeUndefined();
});

test("another error goes to a toast and keeps the form dirty", async () => {
  const { result } = renderHook(() => useFormState(initial));
  act(() => result.current.set("title", "x"));
  await act(() => result.current.submit(() => Promise.reject(new Error("boom"))));
  expect(toast.error).toHaveBeenCalledWith("boom");
  expect(result.current.dirty).toBe(true);
});

test("saving is true while the save runs; success makes the saved value the new start", async () => {
  const { result } = renderHook(() => useFormState(initial));
  let release: () => void = () => {};
  act(() => result.current.set("title", "x"));
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = result.current.submit(() => new Promise<void>((r) => (release = r)));
  });
  expect(result.current.saving).toBe(true);
  await act(async () => {
    release();
    await done;
  });
  expect(result.current.saving).toBe(false);
  expect(result.current.dirty).toBe(false);
});

test("a validator's error shows only for a field the owner has changed", () => {
  const { result } = renderHook(() =>
    useFormState(initial, (v) => (v.name ? {} : { name: "Required" })),
  );
  act(() => result.current.set("title", "x"));
  act(() => result.current.set("name", ""));
  expect(result.current.errors.name).toBe("Required");
  expect(result.current.valid).toBe(false);
});

test("a clean form follows new server data", () => {
  const { result, rerender } = renderHook(({ v }) => useFormState(v), {
    initialProps: { v: initial },
  });
  rerender({ v: { name: "Dev", title: "New" } });
  expect(result.current.value.title).toBe("New");
  expect(result.current.dirty).toBe(false);
  expect(result.current.stale).toBe(false);
});

test("a dirty form keeps the edits, flags stale, and revert loads the new data", () => {
  const { result, rerender } = renderHook(({ v }) => useFormState(v), {
    initialProps: { v: initial },
  });
  act(() => result.current.set("title", "mine"));
  rerender({ v: { name: "Dev", title: "New" } });
  expect(result.current.value.title).toBe("mine");
  expect(result.current.stale).toBe(true);
  act(() => result.current.revert());
  expect(result.current.value.title).toBe("New");
  expect(result.current.stale).toBe(false);
  expect(result.current.dirty).toBe(false);
});

test("saving resets after a failed submit", async () => {
  const { result } = renderHook(() => useFormState(initial));
  await act(() => result.current.submit(() => Promise.reject(new Error("boom"))));
  expect(result.current.saving).toBe(false);
});
