import { afterEach, expect, test, vi } from "vitest";
import { applyWhenSafe, watchForUpdates } from "../../src/app/app-update";

/** Sets what `document.visibilityState` reports and fires the event. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  setVisibility("visible");
  document.body.innerHTML = "";
  vi.useRealTimers();
});

test("a hidden app reloads right away", () => {
  setVisibility("hidden");
  const apply = vi.fn();
  applyWhenSafe(apply, 60_000);
  expect(apply).toHaveBeenCalledTimes(1);
});

test("a page that just loaded, with no field focused, reloads right away", () => {
  const apply = vi.fn();
  applyWhenSafe(apply, 2_000);
  expect(apply).toHaveBeenCalledTimes(1);
});

test("a visible app in use waits until it is hidden, then reloads once", () => {
  const apply = vi.fn();
  applyWhenSafe(apply, 60_000);
  expect(apply).not.toHaveBeenCalled();
  setVisibility("visible");
  expect(apply).not.toHaveBeenCalled();
  setVisibility("hidden");
  setVisibility("hidden");
  expect(apply).toHaveBeenCalledTimes(1);
});

test("a fresh page waits while the owner types in a field", () => {
  document.body.innerHTML = "<textarea></textarea>";
  document.querySelector("textarea")?.focus();
  const apply = vi.fn();
  applyWhenSafe(apply, 2_000);
  expect(apply).not.toHaveBeenCalled();
  setVisibility("hidden");
  expect(apply).toHaveBeenCalledTimes(1);
});

test("checks for a new version when the app is shown or hidden, and every hour", () => {
  vi.useFakeTimers();
  const check = vi.fn();
  const stop = watchForUpdates(check);
  setVisibility("hidden");
  setVisibility("visible");
  expect(check).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(check).toHaveBeenCalledTimes(3);
  stop();
  setVisibility("hidden");
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(check).toHaveBeenCalledTimes(3);
});
