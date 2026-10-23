import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePaths } from "../src/effects/delete-paths";
import { mergeBranch } from "../src/effects/merge-branch";
import { createPullRequest } from "../src/effects/pull-request";
import { purgeThreadTrash } from "../src/effects/purge-trash";
import { teammateEffectsCtx } from "../src/orchestrator/teammate/teammate-effects-ctx";
import type { Runner } from "../src/policy/effect-context";
import { openDb } from "../src/storage/db";
import { effectsOfGoal } from "../src/storage/effect-log-store";
import { stubGateway } from "./helpers";

/* A teammate run has no envelope grant: every effect act asks the owner once (yes / no, fail closed), the audit row says
   `owner`, the trash is keyed by the run. Real files and db, fake owner gate and runner. */

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "owner-act-")));

function setup(answer = true) {
  const home = tmp();
  const repo = join(tmp(), "repo");
  const scratch = join(home, "runs", "r1");
  for (const d of [repo, join(repo, ".git"), scratch]) mkdirSync(d, { recursive: true });
  const asked: string[] = [];
  const cmds: string[] = [];
  const run: Runner = async (cmd) => {
    const line = cmd.join(" ");
    cmds.push(line);
    if (line === "git rev-parse --abbrev-ref HEAD") return { code: 0, out: "feat\n" };
    if (line.startsWith("git rev-parse -q")) return { code: 1, out: "" }; // no merge in progress
    if (line.includes("symbolic-ref")) return { code: 0, out: "origin/main" };
    return { code: 0, out: "ok" };
  };
  const ctx = {
    ...teammateEffectsCtx({
      db: openDb(join(home, "t.db")),
      approvals: stubGateway({
        confirm: async (r) => {
          asked.push(r.summary);
          return { approved: answer };
        },
      }),
      agentHome: home,
      threadId: "t1",
      turnId: "r1",
      language: "en",
      scratchDir: scratch,
      locations: [{ name: "repo", path: repo }],
    }),
    run,
  };
  return { home, repo, ctx, asked, cmds };
}

test("DeletePaths in a location: asks once, a yes moves it to the trash keyed by the run, audit says owner", async () => {
  const s = setup();
  const f = join(s.repo, "old");
  mkdirSync(f);
  writeFileSync(join(f, "a"), "x");
  const r = await deletePaths(s.ctx, { paths: [f], reason: "cleanup" });
  expect(r).toMatchObject({ ok: true, moved: 1 });
  expect(s.asked).toHaveLength(1);
  expect(existsSync(f)).toBe(false);
  expect(existsSync(join(s.home, "trash", "run-r1"))).toBe(true);
  expect(effectsOfGoal(s.ctx.db, "run-r1")[0]).toMatchObject({
    tool: "DeletePaths",
    grantedBy: "owner",
  });
});

test("DeletePaths: a no leaves the path where it was and writes a denied audit row", async () => {
  const s = setup(false);
  const f = join(s.repo, "keep");
  mkdirSync(f);
  const r = await deletePaths(s.ctx, { paths: [f], reason: "cleanup" });
  expect(r).toMatchObject({ ok: false, code: "OWNER_DENIED" });
  expect(existsSync(f)).toBe(true);
  expect(effectsOfGoal(s.ctx.db, "run-r1")).toHaveLength(1);
});

test("CreatePullRequest and a non-default MergeBranch ask once each; a no runs nothing", async () => {
  const no = setup(false);
  const pr = { location: "repo", base: "main", head: "feat", title: "t", body: "b" };
  expect(await createPullRequest(no.ctx, pr)).toMatchObject({ ok: false, code: "OWNER_DENIED" });
  expect(no.cmds.some((c) => c.startsWith("gh pr create"))).toBe(false);

  const yes = setup(true);
  expect(await createPullRequest(yes.ctx, pr)).toMatchObject({ ok: true });
  expect(yes.asked).toHaveLength(1);
  // `origin/HEAD` is `origin/main`, so a merge into `feat` is not a default-branch merge: still one question.
  const merged = await mergeBranch(yes.ctx, { location: "repo", from: "topic", into: "feat" });
  expect(merged).toMatchObject({ ok: true });
  expect(yes.asked).toHaveLength(2);
});

test("/purge also empties the trash of a teammate run (keyed by the run)", async () => {
  const s = setup();
  const f = join(s.repo, "old");
  mkdirSync(f);
  await deletePaths(s.ctx, { paths: [f], reason: "cleanup" });
  expect(existsSync(join(s.home, "trash", "run-r1"))).toBe(true);
  await purgeThreadTrash(s.ctx.db, s.home, "t1", "en", async () => true);
  expect(existsSync(join(s.home, "trash", "run-r1"))).toBe(false);
});
