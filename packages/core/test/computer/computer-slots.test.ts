import { expect, test } from "bun:test";
import { computeSlots } from "../../src";

test("2 CPUs and 2 GB give one slot, limited by memory", () => {
  const r = computeSlots({ cpus: 2, memoryMb: 2048 }, {});
  expect(r).toMatchObject({ slots: 1, limitedBy: "memory" });
});

test("4 CPUs and 6 GB give three slots, limited by memory", () => {
  const r = computeSlots({ cpus: 4, memoryMb: 6144 }, {});
  expect(r).toMatchObject({ slots: 3, limitedBy: "memory" });
  expect(r.text).toBe("3 slots, limited by memory (6144 MB): give Docker more memory for more");
});

test("one CPU gives zero slots, limited by cpu", () => {
  const r = computeSlots({ cpus: 1, memoryMb: 16384 }, {});
  expect(r).toMatchObject({ slots: 0, limitedBy: "cpu" });
});

test("override lowers the slots", () => {
  const r = computeSlots({ cpus: 4, memoryMb: 6144 }, { override: 1 });
  expect(r).toMatchObject({ slots: 1, limitedBy: "setting" });
});

test("override cannot raise the slots", () => {
  const r = computeSlots({ cpus: 4, memoryMb: 6144 }, { override: 9 });
  expect(r).toMatchObject({ slots: 3, limitedBy: "memory" });
});

test("zero slots when memory under one bot", () => {
  const r = computeSlots({ cpus: 8, memoryMb: 1024 }, {});
  expect(r.slots).toBe(0);
  expect(r.text).toContain("memory");
});
