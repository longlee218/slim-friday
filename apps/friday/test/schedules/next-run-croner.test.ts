import { expect, test } from "bun:test";
import { nextRunAtCroner } from "../../src/schedules/next-run-croner";

const SGN = "Asia/Saigon";
const ms = (iso: string) => Date.parse(iso);

test("daily 07:30 picks the next local 07:30", () => {
  const rule = { kind: "daily", at: "07:30" } as const;
  expect(nextRunAtCroner(rule, SGN, ms("2026-10-25T00:00:00Z"))).toBe(ms("2026-10-25T00:30:00Z"));
  expect(nextRunAtCroner(rule, SGN, ms("2026-10-25T00:30:00Z"))).toBe(ms("2026-10-26T00:30:00Z"));
});

test("weekdays 09:00 skips the weekend", () => {
  expect(nextRunAtCroner({ kind: "weekdays", at: "09:00" }, SGN, ms("2026-10-23T03:00:00Z"))).toBe(
    ms("2026-10-26T02:00:00Z"),
  );
});

test("weekly Monday 08:00", () => {
  expect(
    nextRunAtCroner({ kind: "weekly", at: "08:00", weekday: 1 }, SGN, ms("2026-10-25T00:00:00Z")),
  ).toBe(ms("2026-10-26T01:00:00Z"));
});

test("interval keeps phase with an anchor and adds the gap without one", () => {
  const rule = { kind: "interval", every: 45, unit: "minutes" } as const;
  const t = ms("2026-10-25T00:00:00Z");
  const min = 60_000;
  expect(nextRunAtCroner(rule, SGN, t + 100 * min, t)).toBe(t + 135 * min);
  expect(nextRunAtCroner(rule, SGN, t + 90 * min, t)).toBe(t + 135 * min);
  expect(nextRunAtCroner(rule, SGN, t)).toBe(t + 45 * min);
});

test("once gives the instant, or undefined when it has passed", () => {
  const rule = { kind: "once", date: "2026-10-26", at: "15:00" } as const;
  expect(nextRunAtCroner(rule, SGN, ms("2026-10-25T00:00:00Z"))).toBe(ms("2026-10-26T08:00:00Z"));
  expect(nextRunAtCroner(rule, SGN, ms("2026-10-27T00:00:00Z"))).toBeUndefined();
});

test("DST: a skipped local time still fires on that local day", () => {
  const next = nextRunAtCroner(
    { kind: "daily", at: "02:30" },
    "America/New_York",
    ms("2026-03-08T05:00:00Z"),
  );
  expect(next).toBeDefined();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(next);
  expect(day).toBe("2026-03-08");
});

test("DST: a repeated local time fires once that local day", () => {
  const rule = { kind: "daily", at: "01:30" } as const;
  const day = (t: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(t);
  let t = ms("2026-10-31T12:00:00Z");
  const hits: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = nextRunAtCroner(rule, "America/New_York", t);
    if (n === undefined) break;
    hits.push(n);
    t = n;
  }
  expect(hits.filter((h) => day(h) === "2026-11-01")).toHaveLength(1);
});
