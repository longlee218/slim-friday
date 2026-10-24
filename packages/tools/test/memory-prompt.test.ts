import { expect, test } from "bun:test";
import { memoryForPrompt } from "../src/memory/memory-prompt";

const file = [
  "# Memory",
  "",
  "## Decisions",
  "- use sqlite (2026-01-01)",
  "- use bun (2026-09-01)",
  "",
  "## Facts",
  "- fact old (2026-01-02)",
  "- fact new (2026-10-02)",
  "",
  "## Preferences",
  "- short answers (2026-05-01)",
  "",
  "## Lessons",
  "- run tests first (2026-08-01)",
  "",
].join("\n");

test("a file under the cap comes back whole with hidden 0", () => {
  expect(memoryForPrompt(file, 10_000)).toEqual({ text: file, hidden: 0, chars: file.length });
});

test("over the cap: Preferences and Decisions first, newest first, then the rest; the tail line names the hidden count", () => {
  const cap = 160;
  const out = memoryForPrompt(file, cap);
  expect(out.hidden).toBeGreaterThan(0);
  const lines = out.text.split("\n");
  const order = lines.filter((l) => l.startsWith("## ") || l.startsWith("- "));
  expect(order.slice(0, 5)).toEqual([
    "## Preferences",
    "- short answers (2026-05-01)",
    "## Decisions",
    "- use bun (2026-09-01)",
    "- use sqlite (2026-01-01)",
  ]);
  expect(lines.at(-1)).toBe(`(${out.hidden} older notes not shown; MemorySearch finds them.)`);
  const all = memoryForPrompt(file, file.length - 1);
  const kinds = all.text.split("\n").filter((l) => l.startsWith("## "));
  expect(kinds.slice(0, 3)).toEqual(["## Preferences", "## Decisions", "## Lessons"]);
});

test("the result never exceeds maxChars", () => {
  for (const cap of [40, 60, 100, 160, 200, 230, 260]) {
    expect(memoryForPrompt(file, cap).text.length).toBeLessThanOrEqual(cap);
  }
});

test("kinds keep only those sections, also under the cap", () => {
  const r = memoryForPrompt(file, 10_000, ["preference", "lesson"]);
  expect(r.text).toBe(
    "## Preferences\n- short answers (2026-05-01)\n## Lessons\n- run tests first (2026-08-01)",
  );
  expect(r.hidden).toBe(0);
});
