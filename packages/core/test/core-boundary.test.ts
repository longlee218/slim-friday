import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* Boundary scans: `core` is the domain; nothing vendor- or runtime-specific may enter it. */

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** Every .ts file under packages/core/src with its text. */
function coreFiles(): { file: string; text: string }[] {
  return readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => {
      const file = join(e.parentPath, e.name);
      return { file: file.slice(ROOT.length + 1), text: readFileSync(file, "utf8") };
    });
}

/** Files whose text matches `re`, as "file: match". */
const offenders = (re: RegExp, skip?: string) =>
  coreFiles()
    .filter((f) => f.file !== skip)
    .flatMap((f) => (f.text.match(re) ? [`${f.file}: ${f.text.match(re)?.[0]}`] : []));

test("core has no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(pkg.dependencies ?? {}).toEqual({});
});

/** Every module specifier in a file: from "x", import "x", import("x"), require("x"), either quote. */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"']+)\1/g)].map(
    (m) => m[2] ?? "",
  );

test("core imports only its own files", () => {
  const bad = coreFiles().flatMap((f) =>
    specifiers(f.text)
      .filter((spec) => {
        if (!/^\.\.?\//.test(spec)) return true;
        // a relative import must stay inside packages/core/src
        const target = resolve(dirname(join(ROOT, f.file)), spec);
        return !target.startsWith(`${SRC}/`) && target !== SRC;
      })
      .map((spec) => `${f.file}: ${spec}`),
  );
  expect(bad).toEqual([]);
});

test("the scan itself catches what it must", () => {
  expect(
    specifiers(
      "import x from 'a'; import 'b'; await import(\"c\"); require('d'); export * from \"./e\"",
    ),
  ).toEqual(["a", "b", "c", "d", "./e"]);
});

test("core names no vendor or domain", () => {
  expect(offenders(/\b(claude|anthropic|discord|sqlite|drizzle|sdk|git|tiktok)\b/i)).toEqual([]);
});

test("core logic reads no env, console or wall clock", () => {
  expect(
    offenders(
      /process\.env|\bBun\.|console\.|Date\.now\(|new Date\(\)|performance\.now|setTimeout\(|setInterval\(/,
      "src/ports/clock.ts",
    ),
  ).toEqual([]);
});
