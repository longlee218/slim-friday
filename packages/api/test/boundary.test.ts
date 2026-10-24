import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* Boundary scans: api may use contracts, core, web surface, hono, orpc, better-auth and node only. */

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

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

/** Packages whose root and subpaths are allowed. */
const PACKAGES = ["hono", "@orpc/server", "@orpc/contract", "better-auth"];

/** Specifiers this package may use. */
function allowed(spec: string, from: string): boolean {
  const exact = [
    "@friday/contracts",
    "@friday/core",
    "@friday/surface-web",
    "@better-auth/passkey",
  ];
  if (exact.includes(spec) || spec.startsWith("node:")) return true;
  if (PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) return true;
  if (!/^\.\.?\//.test(spec)) return false;
  const target = resolve(dirname(from), spec);
  return target.startsWith(`${SRC}/`) || target === SRC;
}

test("imports only the allowed packages and its own files", () => {
  const bad = filesOf(SRC).flatMap((f) =>
    specifiers(f.text)
      .filter((s) => !allowed(s, f.file))
      .map((s) => `${f.file.slice(ROOT.length + 1)}: ${s}`),
  );
  expect(bad).toEqual([]);
});

test("never imports runtime-claude or store-sqlite", () => {
  const bad = filesOf(SRC).filter((f) => /@friday\/(runtime-claude|store-sqlite)/.test(f.text));
  expect(bad.map((f) => f.file)).toEqual([]);
});

test("no env, console or wall-clock calls", () => {
  const bad = filesOf(SRC).flatMap((f) => {
    const m = f.text.match(/process\.env|console\.|Date\.now\(|new Date\(\)/);
    return m ? [`${f.file.slice(ROOT.length + 1)}: ${m[0]}`] : [];
  });
  expect(bad).toEqual([]);
});
