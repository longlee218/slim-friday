import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* Boundary scans: contracts may use zod, @orpc/contract and its own files only. */

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const CORE_SRC = join(ROOT, "..", "core", "src");

/** Every .ts file under a source dir with its text. */
function filesOf(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => {
      const file = join(e.parentPath, e.name);
      return { file, text: readFileSync(file, "utf8") };
    });
}

/** Every module specifier in a file. */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"']+)\1/g)].map(
    (m) => m[2] ?? "",
  );

/** Specifiers this package may use. */
function allowed(spec: string, from: string): boolean {
  if (spec === "zod" || spec === "@orpc/contract" || spec.startsWith("@orpc/contract/"))
    return true;
  if (!/^\.\.?\//.test(spec)) return false;
  const target = resolve(dirname(from), spec);
  return target.startsWith(`${SRC}/`) || target === SRC;
}

test("imports only zod, @orpc/contract and its own files", () => {
  const bad = filesOf(SRC).flatMap((f) =>
    specifiers(f.text)
      .filter((s) => !allowed(s, f.file))
      .map((s) => `${f.file.slice(ROOT.length + 1)}: ${s}`),
  );
  expect(bad).toEqual([]);
});

test("no env or console", () => {
  const bad = filesOf(SRC).flatMap((f) => {
    const m = f.text.match(/process\.env|console\./);
    return m ? [`${f.file.slice(ROOT.length + 1)}: ${m[0]}`] : [];
  });
  expect(bad).toEqual([]);
});

test("core does not know this package", () => {
  const bad = filesOf(CORE_SRC).filter((f) => /@friday\/contracts/.test(f.text));
  expect(bad.map((f) => f.file)).toEqual([]);
});
