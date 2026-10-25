import { expect, test } from "bun:test";
import { scheduleChangeHook } from "../../src/schedules/schedule-change-hook";

test("fire reaches every subscriber, none before they exist, and unsubscribe works", () => {
  const hook = scheduleChangeHook();
  const seen: string[] = [];
  hook.fire("early");
  const off = hook.subscribe((id) => seen.push(`a:${id}`));
  hook.subscribe((id) => seen.push(`b:${id}`));
  hook.fire("s1");
  off();
  hook.fire("s2");
  expect(seen).toEqual(["a:s1", "b:s1", "b:s2"]);
});

test("a throwing subscriber does not stop the others", () => {
  const hook = scheduleChangeHook();
  const seen: string[] = [];
  hook.subscribe(() => {
    throw new Error("x");
  });
  hook.subscribe((id) => seen.push(id));
  hook.fire("s1");
  expect(seen).toEqual(["s1"]);
});
