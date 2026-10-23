import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactToolCtx } from "../src/artifacts/artifact-access";
import { workspacePaths } from "../src/config/workspace-paths";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { postTaskMessage } from "../src/orchestrator/messages/task-messages";
import { listByGoal } from "../src/storage/artifact-store";
import { makeEnv } from "./helpers";
import { approvedPlan, byKey, TH } from "./plan-fixture";

/* `forward verbatim` makes the artifacts: the result message as md, each file the result names; a second forward adds none. */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A goal with one finished item, a real home, a repo location and a port that can make artifacts. */
function world() {
  const env = makeEnv();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "fwd-repo-")));
  roots.push(repo);
  const { db, goalId } = approvedPlan([
    {
      key: "a",
      subject: "Do a",
      role: "developer",
      brief: "do a",
      location: "repo",
      dependsOn: [],
      risk: "R1",
    },
  ]);
  const itemId = byKey(db, goalId, "a").id;
  const artifacts: ArtifactToolCtx = {
    db,
    home: env.home,
    workspace: "ws1",
    channel: "ch1",
    threadId: TH,
    role: "lead",
    locations: [{ name: "repo", path: repo }],
  };
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer"], locations: ["repo"] },
    io: {
      steerTask: () => "none",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
    artifacts,
  });
  /** The result message of the item, naming `files`. */
  const result = (text: string, files: unknown[] = []) =>
    postTaskMessage(db, {
      threadId: TH,
      goalId,
      taskId: itemId,
      author: "developer",
      kind: "result",
      text,
      ...(files.length && { files: JSON.stringify(files) }),
    });
  return { env, repo, db, goalId, itemId, port, result };
}

test("a result with no file becomes one md artifact, posted by path with its id", () => {
  const w = world();
  w.result("# Login report\n\nall good");
  const plan = w.port.forwardArtifacts(w.itemId)!;
  expect(plan.posts).toHaveLength(1);
  const rows = listByGoal(w.db, w.goalId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    title: "Login report",
    kind: "md",
    origin: "store",
    producerRole: "developer",
    taskId: w.itemId,
  });
  expect(plan.posts[0]).toEqual({ filePath: rows[0]!.path, artifactId: rows[0]!.id });
});

test("a location doc and a scratch copy make 3 artifacts; a second forward makes none", () => {
  const w = world();
  mkdirSync(join(w.repo, "docs"));
  writeFileSync(join(w.repo, "docs", "guide.md"), "# Guide\nsteps");
  const copyDir = workspacePaths(w.env.home).taskFilesOf(w.goalId, w.itemId);
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, "1-mock.html"), "<h1>mock</h1>");
  w.result("# Report\n\nbody", [
    { title: "Guide", base: "location", location: "repo", path: "docs/guide.md" },
    { title: "Mock", base: "scratch", path: join(copyDir, "1-mock.html") },
  ]);
  const first = w.port.forwardArtifacts(w.itemId)!;
  expect(first.posts).toHaveLength(3);
  expect(first.notes).toEqual([]);
  const rows = listByGoal(w.db, w.goalId);
  expect(rows.map((r) => [r.title, r.origin, r.kind])).toEqual([
    ["Report", "store", "md"],
    ["Guide", "repo", "md"],
    ["Mock", "store", "html"],
  ]);
  // The repo artifact is posted from its real file, linked by id.
  expect(first.posts[1]?.filePath).toBe(join(w.repo, "docs", "guide.md"));
  expect(first.posts[1]?.artifactId).toBe(rows[1]!.id);
  const again = w.port.forwardArtifacts(w.itemId)!;
  expect(listByGoal(w.db, w.goalId)).toHaveLength(3);
  expect(again.posts).toEqual(first.posts);
});

test("a location file deleted since the report is a FILE_GONE note; the others are still posted", () => {
  const w = world();
  const copyDir = workspacePaths(w.env.home).taskFilesOf(w.goalId, w.itemId);
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, "1-a.txt"), "kept");
  w.result("# R\n\nbody", [
    { title: "Gone", base: "location", location: "repo", path: "nope.md" },
    { title: "A", base: "scratch", path: join(copyDir, "1-a.txt") },
  ]);
  const plan = w.port.forwardArtifacts(w.itemId)!;
  expect(plan.posts).toHaveLength(2);
  expect(plan.notes).toHaveLength(1);
  expect(plan.notes[0]).toContain("FILE_GONE");
  expect(plan.notes[0]).toContain("Gone");
});

test("no result message: nothing to forward", () => {
  const w = world();
  expect(w.port.forwardArtifacts(w.itemId)).toBeUndefined();
});

test("a second forward re-runs the safety checks: a file swapped for a symlink to a secret is skipped", () => {
  const w = world();
  mkdirSync(join(w.repo, "docs"));
  writeFileSync(join(w.repo, "docs", "guide.md"), "# Guide\nsteps");
  w.result("# R\n\nbody", [
    { title: "Guide", base: "location", location: "repo", path: "docs/guide.md" },
  ]);
  expect(w.port.forwardArtifacts(w.itemId)!.posts).toHaveLength(2);
  // Swap the file for a symlink to a sensitive file inside the repo.
  mkdirSync(join(w.repo, "keys"));
  writeFileSync(join(w.repo, "keys", "secret.md"), "TOP SECRET");
  rmSync(join(w.repo, "docs", "guide.md"));
  symlinkSync(join(w.repo, "keys", "secret.md"), join(w.repo, "docs", "guide.md"));
  const again = w.port.forwardArtifacts(w.itemId)!;
  expect(again.posts).toHaveLength(1); // only the result message
  expect(again.notes[0]).toContain("REFUSED");
});

test("a title with spaces or a secret still finds its rows on the second forward", () => {
  const w = world();
  const copyDir = workspacePaths(w.env.home).taskFilesOf(w.goalId, w.itemId);
  mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(copyDir, "1-a.md"), "# A");
  w.result("# R\n\nbody", [
    { title: "  Spaced  ", base: "scratch", path: join(copyDir, "1-a.md") },
  ]);
  w.port.forwardArtifacts(w.itemId);
  w.port.forwardArtifacts(w.itemId);
  expect(listByGoal(w.db, w.goalId)).toHaveLength(2); // the result and the file, each made once;
});
