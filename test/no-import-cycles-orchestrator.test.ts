import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Every .ts file under `dir`. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Statements `import ... from "x"`, `export ... from "x"` and `import("x")` of a source: [clause, specifier]. */
const STATEMENT =
  /(?:import|export)\s+([^"';]*?)\s*from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** True when the clause only brings types (`type X`, or `{ type A, type B }`): erased at runtime, so no cycle. */
function typeOnly(clause: string): boolean {
  if (/^type\s/.test(clause)) return true;
  const names = clause.match(/^\{([^}]*)\}$/)?.[1];
  if (names === undefined) return false;
  const parts = names
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((x) => x.startsWith("type "));
}

/** Runtime imports of `file` that stay inside src/orchestrator (the files a cycle can run through). */
function runtimeEdges(file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(STATEMENT)) {
    const spec = m[2] ?? m[3];
    if (!spec?.startsWith(".") || (m[1] !== undefined && typeOnly(m[1].trim()))) continue;
    const base = normalize(join(dirname(file), spec));
    const target = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
    if (target?.startsWith("src/orchestrator/")) out.push(target);
  }
  return out;
}

test("src/orchestrator has no runtime import cycle (type-only imports ignored)", () => {
  const graph = new Map(tsFiles("src/orchestrator").map((f) => [f, runtimeEdges(f)]));
  const state = new Map<string, "open" | "done">();
  const cycles: string[] = [];
  /** Depth-first walk; an edge to a file still `open` closes a cycle. */
  const visit = (f: string, stack: string[]): void => {
    state.set(f, "open");
    for (const t of graph.get(f) ?? []) {
      if (state.get(t) === "open")
        cycles.push([...stack.slice(stack.indexOf(t)), f, t].join(" > "));
      else if (!state.has(t)) visit(t, [...stack, f]);
    }
    state.set(f, "done");
  };
  for (const f of graph.keys()) if (!state.has(f)) visit(f, []);
  expect(graph.size).toBeGreaterThan(50);
  expect(cycles).toEqual([]);
});

test("src/orchestrator never imports the discord provider setup (index.ts injects it)", () => {
  const bad = tsFiles("src/orchestrator").filter((f) =>
    [...readFileSync(f, "utf8").matchAll(STATEMENT)].some((m) =>
      /(^|\/)providers(\/|$)/.test(m[2] ?? m[3] ?? ""),
    ),
  );
  expect(bad).toEqual([]);
});
