import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Limits live only as named constants at the top of a role file: the role limits (`MAX_ASK`, `BUDGET_USD`, `MAX_TURNS`) are declared under `src/roles/builtin/`, the per-task ceiling `TASK_BUDGET_USD` only in
 * `config/model-routing.ts`. A second declaration elsewhere would be a second source of truth.
 */
const SRC = join(import.meta.dir, "..", "src");

function tsFiles(rel = ""): string[] {
  return readdirSync(join(SRC, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return tsFiles(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

/** Files that declare `const NAME =` / `export const NAME =` (a declaration, not a use). */
function declaredIn(name: string): string[] {
  const decl = new RegExp(`^\\s*(export\\s+)?const\\s+${name}\\b`, "m");
  return tsFiles().filter((f) => decl.test(readFileSync(join(SRC, f), "utf8")));
}

test("role limit constants are declared only in src/roles/builtin/", () => {
  for (const name of ["MAX_ASK", "BUDGET_USD", "MAX_TURNS"]) {
    const files = declaredIn(name);
    expect(files.length).toBeGreaterThan(0); // not vacuous: the declaration was found
    for (const f of files) expect(f.startsWith("roles/builtin/")).toBe(true);
  }
});

test("TASK_BUDGET_USD is declared only in config/model-routing.ts", () => {
  expect(declaredIn("TASK_BUDGET_USD")).toEqual(["config/model-routing.ts"]);
});
