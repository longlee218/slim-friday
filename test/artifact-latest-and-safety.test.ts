import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type ArtifactToolCtx,
  listArtifacts,
  readArtifact,
  searchChannel,
} from "../src/artifacts/artifact-access";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { workspacePaths } from "../src/config/workspace-paths";
import { logger } from "../src/observability/logger";
import { saveResultFile } from "../src/orchestrator/turns/result-file-save";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { ROLES } from "../src/roles/role-registry";
import { taskStoreArtifacts } from "../src/storage/artifact-list-store";
import { getItem } from "../src/storage/owned-item-store";
import { ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { makeEnv, outsideDir } from "./helpers";

const base = { workspace: "main", channel: "healthy", kind: "md" as const };

/** A tool ctx over the env's db and home, channel `healthy` of space `main`. */
const ctxOf = (env: ReturnType<typeof makeEnv>): ArtifactToolCtx => ({
  db: env.db,
  home: env.home,
  workspace: "main",
  channel: "healthy",
  locations: [],
});

test("list and search leave out code-written rows (summary = 1: plan versions, old result summaries); ReadArtifact still opens them", () => {
  const env = makeEnv();
  const c = ctxOf(env);
  const real = writeArtifact(env.db, env.home, {
    ...base,
    title: "Report",
    body: "quokka deliverable",
  });
  const plan = writeArtifact(env.db, env.home, {
    ...base,
    title: "Plan abcd1234 v1",
    body: "quokka plan",
    summary: true,
  });
  expect(listArtifacts(c).artifacts.map((a) => a.id)).toEqual([real.id]);
  const found = searchChannel(c, { query: "quokka" });
  expect(("hits" in found ? found.hits : []).map((h) => h.id)).toEqual([real.id]);
  expect((readArtifact(c, plan.id) as { text: string }).text).toContain("quokka plan");
});

test("list and search show only the latest version of a name; ReadArtifact still reads an old one", () => {
  const env = makeEnv();
  const v1 = writeArtifact(env.db, env.home, { ...base, title: "Plan", body: "zebra old text" });
  const v2 = writeArtifact(env.db, env.home, { ...base, title: "Plan", body: "zebra new text" });
  const other = writeArtifact(env.db, env.home, { ...base, title: "Other", body: "zebra other" });
  const c = ctxOf(env);
  const listed = listArtifacts(c).artifacts;
  expect(listed.map((a) => [a.id, a.version])).toEqual([
    [other.id, 1],
    [v2.id, 2],
  ]);
  const found = searchChannel(c, { query: "zebra" });
  const hits = "hits" in found ? found.hits : [];
  expect(hits.map((h) => [h.id, h.version]).sort()).toEqual(
    [
      [other.id, 1],
      [v2.id, 2],
    ].sort(),
  );
  expect(hits.some((h) => h.id === v1.id)).toBe(false);
  const old = readArtifact(c, v1.id) as { text: string; version: number };
  expect(old.version).toBe(1);
  expect(old.text).toContain("old text");
});

test("a task that saved the same name twice lists only the newest version (verbatim forward posts it once)", () => {
  const env = makeEnv();
  const taskId = "task-1";
  // v1 is the larger file: without the version filter it would be the primary and post first.
  writeArtifact(env.db, env.home, { ...base, taskId, title: "Import guide", body: "a long draft" });
  const v2 = writeArtifact(env.db, env.home, {
    ...base,
    taskId,
    title: "Import guide",
    body: "final",
  });
  const other = writeArtifact(env.db, env.home, { ...base, taskId, title: "Sample", body: "s" });
  expect(taskStoreArtifacts(env.db, taskId).map((a) => a.id)).toEqual([v2.id, other.id]);
});

test("a run that saved no file writes no artifact: its report is text on the task row; a later saved file is the primary", () => {
  const env = makeEnv();
  const { db, home } = env;
  const role = Object.values(ROLES).find((r) => r.kind === "worker")!.name;
  beginTurn(
    db,
    logger,
    { turnId: "t1", threadId: "th", source: "test" },
    { location: "*", role, brief: "b" },
  );
  const taskId = ownedTaskOfTurn(db, "t1")!;
  const scope = { workspace: "main", channel: "general" };
  const long = "long summary ".repeat(300);
  // First run: no saved file, so no artifact at all; the report is kept as text on the row.
  saveResultFile(db, "t1", "done", "success", long);
  expect(taskStoreArtifacts(db, taskId)).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
  expect(getItem(db, taskId)).toMatchObject({ resultPath: null });
  expect(getItem(db, taskId)?.resultText).toContain("long summary");
  // After a resume the run saves a small file itself: it is the primary and the row keeps no text.
  const saved = writeArtifact(db, home, {
    ...scope,
    kind: "md",
    taskId,
    title: "Report",
    body: "tiny",
  });
  expect(taskStoreArtifacts(db, taskId).map((a) => a.path)).toEqual([saved.path]);
  saveResultFile(db, "t1", "done", "success", "short");
  expect(getItem(db, taskId)?.resultPath).toBe(saved.path);
  expect(getItem(db, taskId)?.resultText).toBeNull();
  expect(db.query("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 1 });
});

test("a symlinked parent dir (artifacts/<ws>, artifacts) that leads outside AGENT_HOME is refused", () => {
  const env = makeEnv();
  const outside = outsideDir();
  const ws = workspacePaths(env.home).workspace("main");
  // `artifacts/main` -> outside the home (the final channel dir does not exist yet, so only the parent is a symlink).
  mkdirSync(join(env.home, "artifacts"), { recursive: true });
  symlinkSync(outside, join(env.home, "artifacts", "main"));
  expect(() => writeArtifact(env.db, env.home, { ...base, title: "T", body: "b" })).toThrow(
    /outside AGENT_HOME/,
  );
  expect(ws.channel("healthy").artifacts.startsWith(env.home)).toBe(true);
  expect(Bun.spawnSync(["ls", outside]).stdout.toString()).toBe(""); // nothing was created out there

  const env2 = makeEnv();
  const out2 = outsideDir();
  symlinkSync(out2, join(env2.home, "artifacts"));
  expect(() => writeArtifact(env2.db, env2.home, { ...base, title: "T", body: "b" })).toThrow(
    /outside AGENT_HOME/,
  );
  expect(Bun.spawnSync(["ls", out2]).stdout.toString()).toBe("");
});
