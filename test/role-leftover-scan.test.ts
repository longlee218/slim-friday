import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every .ts file under `dir` (relative to the repo root), with its source. */
function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push({ file: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

/** Leftovers of the old two-role model: roles are data, so orchestrator and config never name them. */
const FORBIDDEN: Record<string, RegExp> = {
  "role.readOnly": /\breadOnly\b/,
  codeModel: /\bcodeModel\b/,
  CODE_MODEL: /\bCODE_MODEL\b/,
  ASSISTANT_ROLE: /\bASSISTANT_ROLE\b/,
  DEV_ROLE: /\bDEV_ROLE\b/,
};

/** Documented exceptions: file -> forbidden names it may contain, with the reason. Empty today. */
const ALLOW: Record<string, { names: string[]; reason: string }> = {};

test("src/orchestrator/** and src/config/** have no role-name / readOnly / codeModel leftovers", () => {
  const files = [...sources("src/orchestrator"), ...sources("src/config")];
  expect(files.length).toBeGreaterThan(20);
  const hits: string[] = [];
  for (const f of files) {
    for (const [name, re] of Object.entries(FORBIDDEN)) {
      if (re.test(f.text) && !ALLOW[f.file]?.names.includes(name)) hits.push(`${f.file}: ${name}`);
    }
  }
  expect(hits).toEqual([]);
});

test("every allow-list entry is still needed", () => {
  for (const [file, { names }] of Object.entries(ALLOW)) {
    const text = readFileSync(file, "utf8");
    for (const n of names) expect(FORBIDDEN[n]?.test(text)).toBe(true);
  }
});
