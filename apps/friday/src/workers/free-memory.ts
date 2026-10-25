import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** How long one reading is reused (the claimer asks before every claim). */
const CACHE_MS = 5_000;
/** Bytes per MB. */
const MB = 1024 * 1024;

/**
 * Available memory (MB) from macOS `vm_stat` output: free + inactive + speculative pages. Inactive pages are
 * reclaimed on demand, so "free" alone (what `os.freemem` reports) would look near zero on a busy Mac.
 * Undefined when the output cannot be read.
 */
export function parseVmStat(out: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(out)?.[1]);
  const total = pages("free") + pages("inactive") + pages("speculative");
  return Number.isFinite(pageSize * total) ? (pageSize * total) / MB : undefined;
}

/** Available memory (MB) from Linux `/proc/meminfo` (`MemAvailable`, in kB). Undefined when missing. */
export function parseMemInfo(text: string): number | undefined {
  const kb = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(text)?.[1]);
  return Number.isFinite(kb) ? kb / 1024 : undefined;
}

/** One fresh reading for this platform; undefined on another platform or any failure. */
function readAvailableMb(): number | undefined {
  try {
    if (process.platform === "darwin")
      return parseVmStat(execFileSync("vm_stat", { encoding: "utf8", timeout: 1_000 }));
    if (process.platform === "linux") return parseMemInfo(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    // A failed read never blocks work.
  }
  return undefined;
}

/** Last reading and when it was taken. */
let cached: { at: number; mb: number } | undefined;

/**
 * Available memory in MB for the claimer's free-memory floor, cached for 5 s. An unknown value (other platform,
 * failed read) is +Infinity, so the floor never stops claims it cannot measure.
 */
export function availableMemoryMb(now = Date.now()): number {
  if (cached && now - cached.at < CACHE_MS) return cached.mb;
  cached = { at: now, mb: readAvailableMb() ?? Number.POSITIVE_INFINITY };
  return cached.mb;
}
