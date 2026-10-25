import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* Everything meant for publishing holds no personal path, owner identity or token. */

const ROOT = join(import.meta.dir, "..");

/** Files that must exist before the repo is published. */
const REQUIRED = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "docs/ports/surface.md",
  "docs/ports/runtime.md",
  "docs/ports/tools.md",
  "docs/ports/store.md",
  "docs/ports/file-store.md",
  "docs/web-setup.md",
  ".env.example",
  "apps/web/.env.example",
  "apps/web/vercel.json",
];

/** Dirs and files scanned (a dir is walked; `node_modules` is skipped). */
const SCANNED = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "docs/ports",
  "docs/web-setup.md",
  ".env.example",
  "apps",
];
/** Per-package dirs scanned. */
const PACKAGE_DIRS = ["defaults", "templates", "src"];

/** What must not appear (this file is under `test/`, which is not scanned). */
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "personal home path", re: /\/Users\/[A-Za-z]/ },
  { name: "owner name, handle or email", re: /long ?lee|longlh|longle\b|toanhkma/i },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "Discord token", re: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /xox[abp]-[A-Za-z0-9-]{10,}/ },
];

/** Build and test output dirs (and `node_modules`) are never published. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "dev-dist",
  "test-results",
  "playwright-report",
  ".vercel",
]);

/** Every file under `path` (a file is itself). */
function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    SKIPPED_DIRS.has(e.name) ? [] : filesUnder(join(path, e.name)),
  );
}

test("the files a publisher needs exist", () => {
  expect(REQUIRED.filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
});

test("published files hold no personal path, owner identity or token", () => {
  const packages = readdirSync(join(ROOT, "packages"));
  const paths = [
    ...SCANNED.map((p) => join(ROOT, p)),
    ...packages.flatMap((p) => PACKAGE_DIRS.map((d) => join(ROOT, "packages", p, d))),
  ];
  const files = paths.flatMap(filesUnder);
  expect(files.length).toBeGreaterThan(50);
  const hits = files.flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return FORBIDDEN.filter((x) => x.re.test(text)).map((x) => `${relative(ROOT, f)}: ${x.name}`);
  });
  expect(hits).toEqual([]);
});
