import { expect, test } from "vitest";
import {
  fileTypeLabel,
  formatAge,
  formatClock,
  formatCost,
  formatDuration,
  formatSize,
} from "../../src/lib/format";

// Local time on purpose: the helpers read the owner's calendar day.
const now = new Date(2026, 9, 25, 15, 0).getTime();
const at = (y: number, m: number, d: number, h = 9, min = 5) => new Date(y, m, d, h, min).getTime();

test("formatCost", () => {
  expect([1.84, 0, 12.5].map(formatCost)).toEqual(["$1.84", "$0.00", "$12.50"]);
});

test("formatDuration", () => {
  expect([41_000, 520_000, 60_000].map(formatDuration)).toEqual(["41s", "8m 40s", "1m 0s"]);
});

test("formatSize", () => {
  expect([512, 4096, 217_088, 1_258_291].map(formatSize)).toEqual([
    "512 B",
    "4 KB",
    "212 KB",
    "1.2 MB",
  ]);
});

test("formatClock: today, yesterday, weekday, date", () => {
  expect(formatClock(at(2026, 9, 25, 14, 9), now)).toBe("14:09");
  expect(formatClock(at(2026, 9, 24, 23, 59), now)).toBe("Yesterday");
  expect(formatClock(at(2026, 9, 20), now)).toBe("Tue");
  expect(formatClock(at(2026, 9, 12), now)).toBe("12 Oct");
});

test("fileTypeLabel", () => {
  expect(fileTypeLabel("text/markdown", "notes.md")).toBe("Markdown");
  expect(fileTypeLabel("application/octet-stream", "README.md")).toBe("Markdown");
  expect(fileTypeLabel("application/pdf", "a.pdf")).toBe("PDF");
  expect(fileTypeLabel("image/png", "shot.png")).toBe("PNG image");
  expect(fileTypeLabel("application/zip", "bundle.tar.gz")).toBe("GZ");
  expect(fileTypeLabel("application/octet-stream", "noext")).toBe("File");
});

test("formatAge: now, minutes, hours, days", () => {
  const now = 10 * 86_400_000;
  expect(formatAge(now - 20_000, now)).toBe("now");
  expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
  expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h");
  expect(formatAge(now - 2 * 86_400_000, now)).toBe("2d");
});
