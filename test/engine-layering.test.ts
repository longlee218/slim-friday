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

test('engine knows no role names: no "dev" / "lead" string literal under orchestrator/engine', () => {
  const files = sources("src/orchestrator/engine");
  expect(files.length).toBeGreaterThan(5);
  const hits = files.filter((f) => /["'`](dev|scout)["'`]/.test(f.text)).map((f) => f.file);
  expect(hits).toEqual([]);
});

test("thread/ and dispatch/ never import runtime/", () => {
  const files = [...sources("src/orchestrator/thread"), ...sources("src/orchestrator/dispatch")];
  expect(files.length).toBeGreaterThan(1);
  const bad = files.filter((f) => imports(f.text).some((s) => /(^|\/)runtime\//.test(s)));
  expect(bad.map((f) => f.file)).toEqual([]);
});

test("src/roles/** never imports src/orchestrator/**", () => {
  const files = sources("src/roles");
  expect(files.length).toBeGreaterThan(3);
  const bad = files.filter((f) => imports(f.text).some((s) => /(^|\/)orchestrator\//.test(s)));
  expect(bad.map((f) => f.file)).toEqual([]);
});

test("engine/ imports dispatch/ only in worker-run.ts (the detached worker glue); the rest gets ports in", () => {
  const files = sources("src/orchestrator/engine");
  expect(files.length).toBeGreaterThan(5);
  const bad = files
    .filter((f) => !f.file.endsWith("worker-run.ts"))
    .filter((f) => imports(f.text).some((s) => /(^|\/)dispatch(\/|$)/.test(s)));
  expect(bad.map((f) => f.file)).toEqual([]);
});

test("gates.ts stays import-light: no outputs/, mcp/ or storage/ for the thread state", () => {
  const f = sources("src/orchestrator/engine").find((x) => x.file.endsWith("gates.ts"));
  const bad = imports(f?.text ?? "").filter((s) => /outputs\/|mcp\/|storage\//.test(s));
  expect(bad).toEqual([]);
});
