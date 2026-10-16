import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRunner } from "../src/locations/git-run";
import { CREATE_PULL_REQUEST_TOOL } from "../src/mcp/effects/tools/CreatePullRequestTool/constants";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../src/mcp/effects/tools/MergeBranchTool/constants";
import { gitPush } from "../src/orchestrator/effects/git-push";
import { mergeBranch } from "../src/orchestrator/effects/merge-branch";
import { createPullRequest } from "../src/orchestrator/effects/pull-request";
import type { EffectsCtx, Runner } from "../src/policy/effect-context";
import { ANY, defaultEnvelope, type EffectGrant, envelopeWithGrants } from "../src/policy/envelope";
import { openDb } from "../src/storage/db";
import { effectsOfGoal } from "../src/storage/effect-log-store";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* GitPush / MergeBranch / CreatePullRequest: scope checks, R4 asks, audit rows. Real git against a local bare remote. */

// The tools spawn git with the process env: give it an identity for the merge commits (restored after the file).
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
beforeAll(() => void Object.assign(process.env, IDENTITY));
afterAll(() => {
  for (const k of Object.keys(IDENTITY)) delete process.env[k];
});

const tmp = () => tmpRoot("effect-tools-");
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();

/** A repo on `main` with one commit, a bare `origin`, and a `feat/x` branch with its own commit. */
function repo() {
  const bare = join(tmp(), "origin.git");
  git(tmp(), "init", "--bare", bare);
  const dir = join(tmp(), "api");
  Bun.spawnSync(["git", "init", "-b", "main", dir]);
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "checkout", "-b", "feat/x");
  writeFileSync(join(dir, "b.txt"), "b");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "feat");
  git(dir, "checkout", "main");
  return { dir, bare };
}

/** Real git against the local bare remote, except the URL check: a local path is refused by design (https and ssh only), so the remote reads as https. */
const realGit: Runner = (cmd, cwd) =>
  cmd[1] === "remote" && cmd[2] === "get-url"
    ? Promise.resolve({ code: 0, out: "https://example.test/x.git" })
    : spawnRunner(cmd, cwd);

function ctxOf(dir: string, grants: EffectGrant[], run: Runner = realGit, answer = true) {
  const asked: string[] = [];
  const home = tmp();
  const ctx: EffectsCtx = {
    db: openDb(join(home, "t.db")),
    threadId: "t1",
    goalId: "g1",
    itemId: "i1",
    envelope: envelopeWithGrants(defaultEnvelope("g1", ["api"], join(home, "s")), grants),
    locations: [{ name: "api", path: dir }],
    agentHome: home,
    confirm: async (s) => {
      asked.push(s);
      return answer;
    },
    run,
  };
  return { ctx, asked };
}

const push = (branch: string): EffectGrant => ({
  tool: GIT_PUSH_TOOL,
  scope: { location: "api", branch },
});

test("GitPush: a granted feature branch is pushed (no force) and audited; no question", async () => {
  const { dir, bare } = repo();
  const { ctx, asked } = ctxOf(dir, [push("feat/x")]);
  const r = await gitPush(ctx, { location: "api", remote: "origin", branch: "feat/x" });
  expect(r).toMatchObject({ ok: true, pushed: "feat/x" });
  expect(git(bare, "branch", "--list", "feat/x")).toContain("feat/x");
  expect(asked).toEqual([]);
  expect(effectsOfGoal(ctx.db, "g1").find((r) => r.tool === GIT_PUSH_TOOL)).toMatchObject({
    tool: GIT_PUSH_TOOL,
    scope: "api origin feat/x",
    grantedBy: "owner",
  });
});

test("GitPush: outside the grant, bad names, unknown remote or branch are refused and push nothing", async () => {
  const { dir, bare } = repo();
  const { ctx } = ctxOf(dir, [push("feat/x")]);
  const call = (branch: string, remote = "origin", location = "api") =>
    gitPush(ctx, { location, remote, branch });
  expect(await call("feat/y")).toMatchObject({ ok: false, code: "OUT_OF_ENVELOPE" });
  expect(await call("feat/x", "origin", "web")).toMatchObject({ code: "OUT_OF_ENVELOPE" });
  for (const bad of ["-f", "+main", "feat/../x", "a//b", "x.lock", "--all"])
    expect(await call(bad)).toMatchObject({ code: "BAD_REF" });
  expect(await call("feat/x", "nope")).toMatchObject({ code: "BAD_REF" });
  const anyCtx = ctxOf(dir, [push(ANY)]).ctx;
  expect(
    await gitPush(anyCtx, { location: "api", remote: "origin", branch: "ghost" }),
  ).toMatchObject({
    code: "BAD_REF",
  });
  expect(git(bare, "branch", "--list")).toBe("");
  // Nothing was pushed: every row is a refusal (audited), the pin of the remote is the only other row.
  for (const r of effectsOfGoal(ctx.db, "g1").filter((e) => e.tool === GIT_PUSH_TOOL))
    expect(JSON.parse(r.result)).toMatchObject({ result: "refused" });
});

test("GitPush to main is R4 even with a broad grant: the owner is asked at every act", async () => {
  const { dir, bare } = repo();
  const no = ctxOf(dir, [push(ANY)], realGit, false);
  expect(
    await gitPush(no.ctx, { location: "api", remote: "origin", branch: "main" }),
  ).toMatchObject({
    ok: false,
    code: "OWNER_DENIED",
  });
  expect(no.asked).toHaveLength(1);
  expect(git(bare, "branch", "--list")).toBe("");
  const yes = ctxOf(dir, [push(ANY)]);
  expect(
    await gitPush(yes.ctx, { location: "api", remote: "origin", branch: "main" }),
  ).toMatchObject({ ok: true });
  expect(yes.asked).toHaveLength(1);
  expect(git(bare, "branch", "--list", "main")).toContain("main");
});

test("MergeBranch: only into the granted, checked-out branch; a conflict is aborted", async () => {
  const { dir } = repo();
  const grant: EffectGrant = { tool: MERGE_BRANCH_TOOL, scope: { location: "api", into: "main" } };
  const { ctx } = ctxOf(dir, [grant]);
  expect(
    await mergeBranch(ctx, { location: "api", from: "feat/x", into: "developer" }),
  ).toMatchObject({
    code: "OUT_OF_ENVELOPE",
  });
  git(dir, "checkout", "feat/x");
  expect(await mergeBranch(ctx, { location: "api", from: "main", into: "main" })).toMatchObject({
    code: "WRONG_BRANCH",
  });
  git(dir, "checkout", "main");
  const ok = await mergeBranch(ctx, { location: "api", from: "feat/x", into: "main" });
  expect(ok).toMatchObject({ ok: true, merged: "feat/x" });
  expect(git(dir, "log", "--oneline", "-1", "--", "b.txt")).toContain("feat");
  const row = effectsOfGoal(ctx.db, "g1").find((r) => r.undo);
  expect(row?.undo).toMatch(/^git reset --hard [0-9a-f]{40}$/);
  // A conflicting branch: aborted, the tree is clean again.
  git(dir, "checkout", "-b", "c1", "HEAD~1");
  writeFileSync(join(dir, "b.txt"), "other");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "c1");
  git(dir, "checkout", "main");
  const bad = await mergeBranch(ctx, { location: "api", from: "c1", into: "main" });
  expect(bad).toMatchObject({ ok: false, code: "MERGE_FAILED" });
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("CreatePullRequest: runs gh with an argv array for a granted head; default-branch head and ungranted heads are refused", async () => {
  const { dir } = repo();
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    return { code: 0, out: "https://example.test/pr/1" };
  };
  const grant: EffectGrant = {
    tool: CREATE_PULL_REQUEST_TOOL,
    scope: { location: "api", branch: "feat/x" },
  };
  const { ctx } = ctxOf(dir, [grant], run);
  const input = { location: "api", base: "main", head: "feat/x", title: "t; rm -rf /", body: "b" };
  expect(await createPullRequest(ctx, input)).toMatchObject({
    ok: true,
    url: "https://example.test/pr/1",
  });
  expect(calls[0]).toEqual([
    "gh",
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    "feat/x",
    "--title",
    "t; rm -rf /",
    "--body",
    "b",
  ]); // the title is one argument, never a shell line
  expect(await createPullRequest(ctx, { ...input, head: "main" })).toMatchObject({
    code: "BAD_REF",
  });
  expect(await createPullRequest(ctx, { ...input, head: "feat/z" })).toMatchObject({
    code: "OUT_OF_ENVELOPE",
  });
  expect(await createPullRequest(ctxOf(dir, [], run).ctx, input)).toMatchObject({
    code: "OUT_OF_ENVELOPE",
  });
  expect(calls).toHaveLength(1);
  const failing = ctxOf(dir, [grant], async () => ({ code: 1, out: "boom" })).ctx;
  expect(await createPullRequest(failing, input)).toMatchObject({ code: "PR_FAILED" });
});
