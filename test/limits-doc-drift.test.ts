import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { collectLimits } from "../src/config/limits-report";

/* Drift check: every limit in code must have a `<!-- limit:NAME=VALUE -->` marker in docs/limits-and-stop-conditions.md
   with the same value, and every marker must match a code value. Code side = exported numbers of the limit files plus
   the numeric fields of every role (the scan is `collectLimits` in src/config/limits-report.ts). */

/** Markers of the doc as a list (duplicates kept so the test can report them). */
function docMarkers(): { name: string; value: number }[] {
  const text = readFileSync("docs/limits-and-stop-conditions.md", "utf8");
  return [...text.matchAll(/<!-- limit:([\w.-]+)=([\d.]+) -->/g)].map((m) => ({
    name: m[1] ?? "",
    value: Number(m[2]),
  }));
}

test("the limits doc and the code agree on every limit", async () => {
  const code = await collectLimits();
  const markers = docMarkers();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { name, value } of markers) {
    if (seen.has(name)) problems.push(`duplicate marker: ${name}`);
    seen.add(name);
    const actual = code.get(name);
    if (actual === undefined) problems.push(`doc marker without a code limit: ${name}=${value}`);
    else if (actual !== value)
      problems.push(`value mismatch ${name}: doc ${value}, code ${actual}`);
  }
  for (const [name, value] of code)
    if (!seen.has(name)) problems.push(`code limit without a doc marker: ${name}=${value}`);
  // Per-name problems first (they name the limit); this only guards a whole table removed from the doc.
  expect(problems).toEqual([]);
  expect(markers.length).toBeGreaterThanOrEqual(code.size);
});
