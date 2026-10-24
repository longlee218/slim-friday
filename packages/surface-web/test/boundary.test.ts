import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* Boundary scans: the web surface may use core, contracts (types only), image-size, node:* and its own files. */

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** Every .ts file under src with its text. */
const files = () =>
  readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => {
      const file = join(e.parentPath, e.name);
      return { file, text: readFileSync(file, "utf8") };
    });

/** Every module specifier in a file. */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s|\bimport\s|\bimport\(|\brequire\()\s*(["'])([^"']+)\1/g)].map(
    (m) => m[2] ?? "",
  );

test("imports only core, contracts, image-size, node:* and its own files", () => {
  const bad = files().flatMap((f) =>
    specifiers(f.text)
      .filter((s) => {
        if (["@friday/core", "@friday/contracts", "image-size"].includes(s)) return false;
        if (s.startsWith("node:")) return false;
        if (!/^\.\.?\//.test(s)) return true;
        return !resolve(dirname(f.file), s).startsWith(SRC);
      })
      .map((s) => `${f.file.slice(ROOT.length + 1)}: ${s}`),
  );
  expect(bad).toEqual([]);
});

test("contracts are imported as types only", () => {
  const bad = files().flatMap((f) =>
    [...f.text.matchAll(/^import\s+(?!type\b)[^;]*from\s+["']@friday\/contracts["']/gm)].map(() =>
      f.file.slice(ROOT.length + 1),
    ),
  );
  expect(bad).toEqual([]);
});

test("no http, env or console", () => {
  const bad = files().flatMap((f) => {
    const m = f.text.match(/process\.env|Bun\.env|console\.|["']hono|@orpc\//);
    return m ? [`${f.file.slice(ROOT.length + 1)}: ${m[0]}`] : [];
  });
  expect(bad).toEqual([]);
});
