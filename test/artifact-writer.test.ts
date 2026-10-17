import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { workspacePaths } from "../src/config/workspace-paths";
import { getArtifact, listByGoal } from "../src/storage/artifact-store";
import { makeEnv } from "./helpers";

const base = { workspace: "main", channel: "healthy", kind: "md" as const, goalId: "g1" };

test("file under the channel artifacts dir: modes 0700/0600, redacted, row recorded", () => {
  const { db, home } = makeEnv();
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const { id, path, version } = writeArtifact(db, home, {
    ...base,
    title: "Giáo án 8 tuần",
    body: `# plan\n${secret}`,
    producerRole: "scout",
  });
  const dir = workspacePaths(home).workspace("main").channel("healthy").artifacts;
  expect(path).toBe(join(dir, "giao-an-8-tuan.md"));
  expect(version).toBe(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(readFileSync(path, "utf8")).not.toContain(secret);
  const row = getArtifact(db, id)!;
  expect(row).toMatchObject({
    title: "Giáo án 8 tuần",
    name: "giao-an-8-tuan.md",
    origin: "store",
    channel: "healthy",
    goalId: "g1",
    producerRole: "scout",
  });
  expect(listByGoal(db, "g1")).toHaveLength(1);
});

test("same name in the same channel gets -v2, -v3; the old files stay; another channel starts at v1", () => {
  const { db, home } = makeEnv();
  const w = (channel: string) =>
    writeArtifact(db, home, { ...base, channel, title: "Report", body: channel });
  const a = w("healthy");
  const b = w("healthy");
  const c = w("healthy");
  const other = w("work");
  expect([a.version, b.version, c.version, other.version]).toEqual([1, 2, 3, 1]);
  expect(b.path.endsWith("report-v2.md")).toBe(true);
  expect(existsSync(a.path) && existsSync(b.path) && existsSync(c.path)).toBe(true);
});

test("a file already on disk but not in the db is never overwritten", () => {
  const { db, home } = makeEnv();
  const dir = workspacePaths(home).workspace("main").channel("healthy").artifacts;
  mkdirSync(dir, { recursive: true });
  Bun.write(join(dir, "report.md"), "stray");
  const r = writeArtifact(db, home, { ...base, title: "Report", body: "new" });
  expect(r.path.endsWith("report-v2.md")).toBe(true);
  expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("stray");
});

test("no channel: workspace-level artifacts dir; no title: the fallback name", () => {
  const { db, home } = makeEnv();
  const { path } = writeArtifact(db, home, {
    workspace: "main",
    kind: "txt",
    body: "x",
    fallbackName: "result-main",
  });
  expect(path).toBe(join(home, "workspaces", "main", "artifacts", "result-main.txt"));
});

test("a symlinked artifacts dir is refused; a planted symlink at the target is replaced", () => {
  const { db, home } = makeEnv();
  const dir = workspacePaths(home).workspace("main").channel("healthy").artifacts;
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere);
  mkdirSync(join(dir, ".."), { recursive: true });
  symlinkSync(elsewhere, dir);
  expect(() => writeArtifact(db, home, { ...base, title: "T", body: "b" })).toThrow(/symlink/);

  const env = makeEnv();
  const d2 = workspacePaths(env.home).workspace("main").channel("healthy").artifacts;
  mkdirSync(d2, { recursive: true });
  const victim = join(env.home, "victim.txt");
  Bun.write(victim, "keep");
  symlinkSync(victim, join(d2, "t-v2.md")); // exists on disk: version moves past it
  const r = writeArtifact(env.db, env.home, { ...base, title: "T", body: "b" });
  expect(lstatSync(r.path).isSymbolicLink()).toBe(false);
  expect(readFileSync(victim, "utf8")).toBe("keep");
});

test("workspace and channel names that could leave the home are refused", () => {
  const { db, home } = makeEnv();
  expect(() => writeArtifact(db, home, { ...base, workspace: "../x", body: "b" })).toThrow(/bad/);
  expect(() => writeArtifact(db, home, { ...base, channel: "../x", body: "b" })).toThrow(/bad/);
});
