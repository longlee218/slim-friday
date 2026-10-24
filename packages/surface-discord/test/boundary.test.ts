import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* Boundary scans: surface-discord may use core, node and (in one file) discord.js. */

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const CORE_SRC = join(ROOT, "..", "core", "src");
/** The only file that may import discord.js. */
const ADAPTER = "src/discord-js-port.ts";

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

/** Specifiers a file may use. */
function allowed(spec: string, from: string): boolean {
  if (spec === "@friday/core" || spec.startsWith("node:")) return true;
  if (spec === "discord.js")
    return from.endsWith(ADAPTER) || from.endsWith("private-overwrites.ts");
  if (!/^\.\.?\//.test(spec)) return false;
  const target = resolve(dirname(from), spec);
  return target.startsWith(`${SRC}/`) || target === SRC;
}

test("imports only core, node, own files; discord.js only in the adapter files", () => {
  const bad = filesOf(SRC).flatMap((f) =>
    specifiers(f.text)
      .filter((s) => !allowed(s, f.file))
      .map((s) => `${f.file.slice(ROOT.length + 1)}: ${s}`),
  );
  expect(bad).toEqual([]);
});

test("no env, console or wall-clock calls", () => {
  const bad = filesOf(SRC).flatMap((f) => {
    const m = f.text.match(/process\.env|console\.|Date\.now\(|new Date\(\)/);
    return m ? [`${f.file.slice(ROOT.length + 1)}: ${m[0]}`] : [];
  });
  expect(bad).toEqual([]);
});

test("core does not know this package", () => {
  const bad = filesOf(CORE_SRC).filter((f) => /surface-discord/.test(f.text));
  expect(bad.map((f) => f.file)).toEqual([]);
});
