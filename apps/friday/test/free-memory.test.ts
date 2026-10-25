import { describe, expect, test } from "bun:test";
import { availableMemoryMb, parseMemInfo, parseVmStat } from "../src/workers/free-memory";

describe("free memory", () => {
  test("vm_stat counts free, inactive and speculative pages", () => {
    const out = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                     8192.",
      "Pages active:                                 188706.",
      "Pages inactive:                               131072.",
      "Pages speculative:                              4096.",
    ].join("\n");
    // (8192 + 131072 + 4096) pages * 16 KB = 2240 MB.
    expect(parseVmStat(out)).toBe(2240);
  });

  test("unreadable vm_stat output is unknown", () => {
    expect(parseVmStat("garbage")).toBeUndefined();
  });

  test("meminfo reads MemAvailable", () => {
    const text =
      "MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    2097152 kB\n";
    expect(parseMemInfo(text)).toBe(2048);
    expect(parseMemInfo("MemTotal: 1 kB\n")).toBeUndefined();
  });

  test("a live reading is a positive number (or unknown = Infinity) and is cached", () => {
    const first = availableMemoryMb(1_000);
    expect(first).toBeGreaterThan(0);
    expect(availableMemoryMb(2_000)).toBe(first);
  });
});
