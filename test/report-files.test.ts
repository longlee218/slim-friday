import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_REPO_DOC_MAX_BYTES } from "../src/artifacts/artifact-limits";
import { REPORT_FILE_MAX_BYTES } from "../src/config/message-caps";
import { checkReportFiles, type ReportFile } from "../src/orchestrator/worker/report-files";

/* Report result `files`: named deliverables are checked at report time; a scratch file is copied into task-files. */

let base: string;
beforeEach(() => {
  base = realpathOf(mkdtempSync(join(tmpdir(), "report-files-")));
  for (const d of ["home", "scratch", "repo"]) mkdirSync(join(base, d));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const realpathOf = (p: string) => require("node:fs").realpathSync(p) as string;
const at = (...p: string[]) => join(base, ...p);
/** Check against the scratch dir (no granted location) or the repo (granted). */
const check = (files: { title: string; path: string }[], granted = false) =>
  checkReportFiles(files, {
    home: at("home"),
    copyDir: at("home", "task-files", "g1", "t1"),
    scratchDir: at("scratch"),
    ...(granted && { granted: { name: "repo", path: at("repo") } }),
  });
const okFiles = (r: ReturnType<typeof check>): ReportFile[] => {
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r.files;
};

test("a location doc is a reference: nothing is copied", () => {
  writeFileSync(at("repo", "plan.md"), "# plan");
  const [f] = okFiles(check([{ title: "Plan", path: "plan.md" }], true));
  expect(f).toEqual({ title: "Plan", base: "location", location: "repo", path: "plan.md" });
  expect(existsSync(at("home", "task-files"))).toBe(false);
});

test("a scratch file is copied under task-files and the entry points to the copy", () => {
  writeFileSync(at("scratch", "mock.html"), "<h1>x</h1>");
  const [f] = okFiles(check([{ title: "Mock", path: "./mock.html" }]));
  expect(f?.base).toBe("scratch");
  expect(f?.path).toBe(at("home", "task-files", "g1", "t1", "1-mock.html"));
  expect(readFileSync(f!.path, "utf8")).toBe("<h1>x</h1>");
  expect(statSync(f!.path).mode & 0o777).toBe(0o600);
  rmSync(at("scratch", "mock.html")); // the original may go: the copy stays
  expect(existsSync(f!.path)).toBe(true);
});

test("refused: over the size cap, escape, symlink out, sensitive, code file, missing, absolute path", () => {
  writeFileSync(at("scratch", "big.txt"), "x".repeat(REPORT_FILE_MAX_BYTES + 1));
  writeFileSync(at("scratch", ".env"), "K=1");
  writeFileSync(at("scratch", "a.ts"), "code");
  writeFileSync(at("home", "secret.md"), "s");
  writeFileSync(at("outside.md"), "o");
  symlinkSync(at("home", "secret.md"), at("scratch", "link.md"));
  const bad = [
    "big.txt",
    "../outside.md",
    "link.md",
    ".env",
    "a.ts",
    "none.md",
    at("scratch", "a.ts"),
  ];
  for (const path of bad) {
    const r = check([{ title: "T", path }]);
    expect([path, "errors" in r]).toEqual([path, true]);
  }
  expect(existsSync(at("home", "task-files"))).toBe(false); // a refused report copies nothing
});

test("one bad entry refuses the whole report and leaves no copy", () => {
  writeFileSync(at("scratch", "ok.md"), "fine");
  const r = check([
    { title: "A", path: "ok.md" },
    { title: "B", path: "missing.md" },
  ]);
  expect("errors" in r && r.errors).toHaveLength(1);
  expect(readdirSync(at("home", "task-files", "g1", "t1"))).toEqual([]);
});

test("a granted location file over the repo doc cap is refused", () => {
  writeFileSync(at("repo", "big.md"), "x".repeat(REPORT_REPO_DOC_MAX_BYTES + 1));
  expect("errors" in check([{ title: "T", path: "big.md" }], true)).toBe(true);
});
