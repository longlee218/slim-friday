import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

test("core imports only its own files", () => {
  const bad = coreFiles().flatMap((f) =>
    [...f.text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)]
      .filter((m) => !/^\.\.?\//.test(m[1] ?? ""))
      .map((m) => `${f.file}: ${m[1]}`),
  );
  expect(bad).toEqual([]);
});

test("core names no vendor or domain", () => {
  expect(offenders(/\b(claude|anthropic|discord|sqlite|drizzle|sdk|git|tiktok)\b/i)).toEqual([]);
});

test("core logic reads no env, console or wall clock", () => {
  expect(
    offenders(
      /process\.env|console\.|Date\.now\(|setTimeout\(|setInterval\(/,
      "src/ports/clock.ts",
    ),
  ).toEqual([]);
});
