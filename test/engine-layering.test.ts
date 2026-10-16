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

/** Module specifiers of the `import ... from "x"` / `import("x")` statements of a source. */
const imports = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);

/** The generic run code: the former engine dir, now lead / worker / run / goal. */
const ENGINE_DIRS = ["lead", "worker", "run", "goal"].map((d) => `src/orchestrator/${d}`);

test('engine knows no role names: no "developer" / "lead" string literal under orchestrator/{lead,worker,run,goal}', () => {
  const files = ENGINE_DIRS.flatMap(sources);
  expect(files.length).toBeGreaterThan(5);
  const hits = files
    .filter((f) => /["'`](dev|developer|scout)["'`]/.test(f.text))
    .map((f) => f.file);
  expect(hits).toEqual([]);
});

test("thread/ never imports runtime/", () => {
  const files = sources("src/orchestrator/thread");
  expect(files.length).toBeGreaterThan(0);
  const bad = files.filter((f) => imports(f.text).some((s) => /(^|\/)runtime\//.test(s)));
  expect(bad.map((f) => f.file)).toEqual([]);
});

test("src/roles/** never imports src/orchestrator/**", () => {
  const files = sources("src/roles");
  expect(files.length).toBeGreaterThan(3);
  const bad = files.filter((f) => imports(f.text).some((s) => /(^|\/)orchestrator\//.test(s)));
  expect(bad.map((f) => f.file)).toEqual([]);
});

test("gates.ts stays import-light: no outputs/, mcp/ or storage/ for the thread state", () => {
  const f = ENGINE_DIRS.flatMap(sources).find((x) => x.file.endsWith("gates.ts"));
  const bad = imports(f?.text ?? "").filter((s) => /outputs\/|mcp\/|storage\//.test(s));
  expect(bad).toEqual([]);
});
