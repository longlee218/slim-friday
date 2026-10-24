import type { WakeStatus } from "@friday/contracts";
import { expect, test } from "vitest";
import {
  dayRange,
  limitTone,
  spendDays,
  wakeBucket,
} from "../../src/components/activity/activity-math";

test("spendDays fills missing days with zero, sums per day, oldest first", () => {
  const out = spendDays(
    [
      { botId: "dev", day: "2026-10-24", usd: 0.5 },
      { botId: "pia", day: "2026-10-24", usd: 0.25 },
      { botId: "dev", day: "2026-10-22", usd: 1 },
      { botId: "dev", day: "2026-09-01", usd: 9 },
    ],
    "2026-10-24",
    7,
  );
  expect(out.map((d) => d.day)).toEqual([
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
  ]);
  expect(out[4]).toEqual({ day: "2026-10-22", byBot: { dev: 1 }, total: 1 });
  expect(out[5]).toEqual({ day: "2026-10-23", byBot: {}, total: 0 });
  expect(out[6]).toEqual({ day: "2026-10-24", byBot: { dev: 0.5, pia: 0.25 }, total: 0.75 });
});

test("spendDays 30 days crosses a month and stays inside the 31 day API limit", () => {
  const out = spendDays([], "2026-03-02", 30);
  expect(out).toHaveLength(30);
  expect(out[0]?.day).toBe("2026-02-01");
  expect(dayRange("2026-03-02", 30)).toEqual({ from: "2026-02-01", to: "2026-03-02" });
});

test("limitTone: tint under 50%, amber from 50%, red at 100%", () => {
  expect(limitTone(0.49)).toBe("tint");
  expect(limitTone(0.5)).toBe("amber");
  expect(limitTone(0.99)).toBe("amber");
  expect(limitTone(1)).toBe("red");
  expect(limitTone(1.4)).toBe("red");
});

test("wakeBucket groups every wake status", () => {
  const expected: Record<WakeStatus, "running" | "failed" | "other"> = {
    queued: "running",
    running: "running",
    done: "other",
    expired: "other",
    blocked: "failed",
    interrupted: "failed",
    dropped: "failed",
  };
  for (const [s, b] of Object.entries(expected)) expect(wakeBucket(s as WakeStatus)).toBe(b);
});
