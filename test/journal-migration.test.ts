import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { JOURNAL_PER_CHANNEL_STEP, migrateJournals } from "../src/memory/journal-migration";
import { readMarker } from "../src/memory/memory-migration-marker";
import { ensureHome } from "../src/memory/persona";
import { captureLogs } from "../src/observability/logger";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { clearWorkspaces, makeEnv } from "./helpers";

/** Write a file (parents created) and return its path. */
function put(file: string, text: string): string {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** Home with space `solo` (one channel `only`), `duo` (channels `one`, `two`) and `none` (no channel). */
function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const chan = (id: string, name: string) => `  - {id: "${id}", name: ${name}, mode: task}\n`;
  const space = (name: string, channels: string) =>
    put(
      join(env.home, "workspaces", name, "workspace.yaml"),
      channels ? `channels:\n${channels}` : "channels: []\n",
    );
  space("solo", chan("33333333333333331", "only"));
  space("duo", chan("33333333333333332", "one") + chan("33333333333333333", "two"));
  space("none", "");
  const scan = loadWorkspaces(env.home);
  ensureHome(env.home, scan.workspaces);
  const old = (name: string, day: string, text: string) =>
    put(join(workspacePaths(env.home).workspace(name).root, "memory", `${day}.md`), text);
  return { env, scan, home: env.home, old };
}

test("one-channel space copies its day files, 2+ and 0 channel spaces leave them; sources unchanged; idempotent", () => {
  const s = setup();
  const solo = s.old("solo", "2026-10-12", "## 10:00 t\n### Facts\n- solo fact\n");
  const soloB = s.old("solo", "2026-10-13", "## 11:00 t\n### Facts\n- solo two\n");
  const duo = s.old("duo", "2026-10-12", "## 10:00 t\n### Facts\n- duo fact\n");
  const none = s.old("none", "2026-10-12", "## 10:00 t\n### Facts\n- none fact\n");
  put(join(s.home, "workspaces", "solo", "memory", "notes.md"), "not a day file");
  const files = [solo, soloB, duo, none];
  const before = files.map((f) => readFileSync(f).toString("base64"));
  // The destination already has this day: it is kept, not overwritten.
  const dest = workspacePaths(s.home).workspace("solo").channel("only").journalDir;
  put(join(dest, "2026-10-13.md"), "existing copy\n");

  const logs = captureLogs();
  const r = migrateJournals(s.home, s.scan.workspaces);
  logs.stop();
  expect(r).toEqual({ copied: 1, left: 3, failed: 0 }); // solo-12 copied; solo-13 (exists), duo, none left
  expect(readFileSync(join(dest, "2026-10-12.md"), "utf8")).toBe(readFileSync(solo, "utf8"));
  expect(readFileSync(join(dest, "2026-10-13.md"), "utf8")).toBe("existing copy\n");
  expect(existsSync(join(dest, "notes.md"))).toBe(false);
  for (const ch of ["one", "two"])
    expect(existsSync(workspacePaths(s.home).workspace("duo").channel(ch).journalDir)).toBe(false);
  expect(files.map((f) => readFileSync(f).toString("base64"))).toEqual(before);
  expect(Object.keys(readMarker(s.home))).toEqual([JOURNAL_PER_CHANNEL_STEP]);
  expect(logs.lines.find((l) => l.event === "memory.migrate")).toMatchObject({
    step: JOURNAL_PER_CHANNEL_STEP,
    copied: 1,
    left: 3,
  });
  expect(JSON.stringify(logs.lines)).not.toContain("solo fact");

  // Marker present: a second call does nothing.
  expect(migrateJournals(s.home, s.scan.workspaces)).toEqual({ copied: 0, left: 0, failed: 0 });
});

test("a space that is not loaded counts as failed: no marker, the next start retries", () => {
  const s = setup();
  s.old("solo", "2026-10-12", "## 10:00 t\n### Facts\n- a\n");
  expect(migrateJournals(s.home, []).failed).toBe(1);
  expect(Object.keys(readMarker(s.home))).toEqual([]);
  expect(migrateJournals(s.home, s.scan.workspaces).copied).toBe(1);
  expect(Object.keys(readMarker(s.home))).toEqual([JOURNAL_PER_CHANNEL_STEP]);
});

test("a symlinked day file is never followed", () => {
  const s = setup();
  const dir = join(s.home, "workspaces", "solo", "memory");
  const secret = put(join(s.home, "secret.txt"), "top secret\n");
  mkdirSync(dir, { recursive: true });
  symlinkSync(secret, join(dir, "2026-10-12.md"));
  expect(migrateJournals(s.home, s.scan.workspaces)).toEqual({ copied: 0, left: 1, failed: 0 });
  const dest = workspacePaths(s.home).workspace("solo").channel("only").journalDir;
  expect(existsSync(join(dest, "2026-10-12.md"))).toBe(false);
});

test("a copied day file is mode 0600 even when the source is 0644; no temp file is left", () => {
  const s = setup();
  const src = s.old("solo", "2026-10-12", "## 10:00 t\n### Facts\n- a\n");
  chmodSync(src, 0o644);
  expect(migrateJournals(s.home, s.scan.workspaces).copied).toBe(1);
  const dest = workspacePaths(s.home).workspace("solo").channel("only").journalDir;
  expect(statSync(join(dest, "2026-10-12.md")).mode & 0o777).toBe(0o600);
  expect(statSync(dest).mode & 0o777).toBe(0o700);
  expect(readdirSync(dest)).toEqual(["2026-10-12.md"]);
});

test("a symlinked target dir counts as failed and nothing is written", () => {
  const s = setup();
  s.old("solo", "2026-10-12", "## 10:00 t\n### Facts\n- a\n");
  const dest = workspacePaths(s.home).workspace("solo").channel("only").journalDir;
  const elsewhere = join(s.home, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  symlinkSync(elsewhere, dest);
  expect(migrateJournals(s.home, s.scan.workspaces)).toEqual({ copied: 0, left: 0, failed: 1 });
  expect(readdirSync(elsewhere)).toEqual([]);
  expect(Object.keys(readMarker(s.home))).toEqual([]);
});
