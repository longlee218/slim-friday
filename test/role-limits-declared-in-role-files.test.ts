import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Limits live only in the role's preset file (`config/presets/<role>/preset.yaml`: `limits.maxAsk`, `limits.maxTurns`, `budgetUsd`); the per-task ceiling
 * `TASK_BUDGET_USD` only in `config/model-routing.ts`. A constant of the same name in `src/` would be a second source of truth.
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

test("role limits are declared in the preset files, not as constants in src/", () => {
  for (const name of ["MAX_ASK", "BUDGET_USD", "MAX_TURNS"]) expect(declaredIn(name)).toEqual([]);
  const presets = join(import.meta.dir, "..", "config", "presets");
  const roles = readdirSync(presets, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && !e.name.startsWith("_"),
  );
  expect(roles.length).toBeGreaterThan(0);
  for (const r of roles) {
    const text = readFileSync(join(presets, r.name, "preset.yaml"), "utf8");
    for (const key of ["maxAsk:", "maxTurns:", "budgetUsd:"])
      expect([r.name, text.includes(key)]).toEqual([r.name, true]);
  }
});

test("TASK_BUDGET_USD is declared only in config/model-routing.ts", () => {
  expect(declaredIn("TASK_BUDGET_USD")).toEqual(["config/model-routing.ts"]);
});
