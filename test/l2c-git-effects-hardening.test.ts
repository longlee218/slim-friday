import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPush } from "../src/mcp/effects/git-push";
import { mergeBranch } from "../src/mcp/effects/merge-branch";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../src/mcp/effects/tools/MergeBranchTool/constants";
import type { EffectsCtx, Runner } from "../src/policy/effect-context";
import { ANY, defaultEnvelope, type EffectGrant, envelopeWithGrants } from "../src/policy/envelope";
import { openDb } from "../src/storage/db";
import { effectsOfGoal } from "../src/storage/effect-log-store";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* GitPush default-branch detection and remote pinning, MergeBranch abort only when it started the merge. Fake runner. */

const base = tmpRoot("l2c-git-");
let n = 0;

/** A fake git: `script` answers by argv text; every call is recorded. */
function setup(grants: EffectGrant[], script: (cmd: string) => { code: number; out: string }) {
  const id = `s${n++}`;
  const dir = join(base, id, "api");
  const home = join(base, id, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const calls: string[] = [];
  const asked: string[] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd.join(" "));
    return script(cmd.join(" "));
  };
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
      return false;
    },
    run,
  };
  return { ctx, calls, asked };
}

const pushGrant: EffectGrant = { tool: GIT_PUSH_TOOL, scope: { location: "api", branch: ANY } };
const push = (branch: string) => ({ location: "api", remote: "origin", branch });

/** Default fake remote: url, ls-remote answer (default branch `prod`) and every other git call succeeds. */
const remote = (url: string, symref: string) => (cmd: string) => {
  if (cmd.startsWith("git remote get-url")) return { code: 0, out: url };
  if (cmd.startsWith("git ls-remote")) return { code: symref ? 0 : 1, out: symref };
  if (cmd === "git remote") return { code: 0, out: "origin" };
  return { code: 0, out: "ok" };
};

test("push: the remote's own default branch (ls-remote --symref) asks at every act, even with a grant", async () => {
  const s = setup([pushGrant], remote("https://h/x.git", "ref: refs/heads/prod\tHEAD\nabc\tHEAD"));
  expect(await gitPush(s.ctx, push("prod"))).toMatchObject({ code: "OWNER_DENIED" });
  expect(await gitPush(s.ctx, push("prod"))).toMatchObject({ code: "OWNER_DENIED" });
  expect(s.asked).toHaveLength(2);
  expect(s.calls.some((c) => c.startsWith("git push"))).toBe(false);
  // A feature branch is not asked.
  expect(await gitPush(s.ctx, push("feat/x"))).toMatchObject({ ok: true });
  expect(s.asked).toHaveLength(2);
});

test("push: default unknown (ls-remote fails) -> main, master, develop, trunk, release* count as default", async () => {
  const s = setup([pushGrant], remote("https://h/x.git", ""));
  for (const b of ["develop", "trunk", "release-1.2", "main"]) {
    expect(await gitPush(s.ctx, push(b))).toMatchObject({ code: "OWNER_DENIED" });
  }
  expect(s.asked).toHaveLength(4);
});

test("push: ext:: and file remotes are refused; a remote whose URL changed after first use is refused", async () => {
  for (const url of ["ext::sh -c touch% x", "file:///tmp/x", "/tmp/x.git", "../x"]) {
    const s = setup([pushGrant], remote(url, ""));
    expect(await gitPush(s.ctx, push("feat/x"))).toMatchObject({ code: "BAD_REMOTE" });
    expect(s.calls.some((c) => c.startsWith("git push"))).toBe(false);
  }
  let url = "git@github.com:me/x.git";
  const s = setup([pushGrant], (cmd) => remote(url, "ref: refs/heads/prod\tHEAD")(cmd));
  expect(await gitPush(s.ctx, push("feat/x"))).toMatchObject({ ok: true }); // first use pins it
  url = "https://evil.example/x.git";
  expect(await gitPush(s.ctx, push("feat/x"))).toMatchObject({ code: "REMOTE_CHANGED" });
  expect(s.calls.filter((c) => c.startsWith("git push"))).toHaveLength(1);
  const pin = effectsOfGoal(s.ctx.db, "g1").find((r) => r.tool === "RemotePin");
  expect(pin?.scope).not.toContain("github"); // a hash, never the URL (it may hold credentials)
});

test("push: every refusal is audited with its code", async () => {
  const s = setup([], remote("https://h/x.git", ""));
  await gitPush(s.ctx, push("feat/x"));
  const rows = effectsOfGoal(s.ctx.db, "g1").filter((r) => r.tool === GIT_PUSH_TOOL);
  expect(rows.map((r) => JSON.parse(r.result))).toEqual([
    { result: "refused", code: "OUT_OF_ENVELOPE" },
  ]);
});

/** A fake merge: MERGE_HEAD exists before (`pending`) and/or after a failed merge (`conflict`). */
function mergeScript(opts: { pending: boolean; conflict: boolean; into?: string }) {
  let merged = false;
  return (cmd: string) => {
    if (cmd.includes("--abbrev-ref")) return { code: 0, out: opts.into ?? "integration" };
    if (cmd.includes("MERGE_HEAD"))
      return { code: opts.pending || (merged && opts.conflict) ? 0 : 1, out: "" };
    if (cmd.startsWith("git merge --no-edit")) {
      merged = true;
      return { code: 1, out: "CONFLICT" };
    }
    return { code: 0, out: "abc" };
  };
}
const mergeGrant: EffectGrant = { tool: MERGE_BRANCH_TOOL, scope: { location: "api", into: ANY } };
const mergeInput = { location: "api", from: "feat/x", into: "integration" };

test("merge: a merge already in progress is refused and never aborted", async () => {
  const s = setup([mergeGrant], mergeScript({ pending: true, conflict: false }));
  expect(await mergeBranch(s.ctx, mergeInput)).toMatchObject({ code: "MERGE_IN_PROGRESS" });
  expect(s.calls.some((c) => c.includes("--abort") || c.startsWith("git merge --no-edit"))).toBe(
    false,
  );
});

test("merge: --abort only when this call started the merge (MERGE_HEAD appeared)", async () => {
  const conflict = setup([mergeGrant], mergeScript({ pending: false, conflict: true }));
  expect(await mergeBranch(conflict.ctx, mergeInput)).toMatchObject({ code: "MERGE_FAILED" });
  expect(conflict.calls).toContain("git merge --abort");
  const refusedMerge = setup([mergeGrant], mergeScript({ pending: false, conflict: false }));
  expect(await mergeBranch(refusedMerge.ctx, mergeInput)).toMatchObject({ code: "MERGE_FAILED" });
  expect(refusedMerge.calls).not.toContain("git merge --abort"); // e.g. a dirty tree: no merge started
});

test("merge: INTO a default branch asks the owner at every call, grant `into: *` or not; a no merges nothing", async () => {
  for (const into of ["main", "master"]) {
    const s = setup([mergeGrant], mergeScript({ pending: false, conflict: false, into }));
    expect(await mergeBranch(s.ctx, { ...mergeInput, into })).toMatchObject({
      code: "OWNER_DENIED",
    });
    expect(s.asked).toHaveLength(1);
    expect(s.calls.some((c) => c.startsWith("git merge --no-edit"))).toBe(false);
    // A yes goes on to the merge (the fake one conflicts), and asks again on the next call (never remembered).
    s.ctx.confirm = async (q) => (s.asked.push(q), true);
    expect(await mergeBranch(s.ctx, { ...mergeInput, into })).toMatchObject({
      code: "MERGE_FAILED",
    });
    await mergeBranch(s.ctx, { ...mergeInput, into });
    expect(s.asked).toHaveLength(3);
  }
  // A feature branch inside the grant is not asked.
  const f = setup([mergeGrant], mergeScript({ pending: false, conflict: false }));
  await mergeBranch(f.ctx, mergeInput);
  expect(f.asked).toHaveLength(0);
});

test("L4 push: an unreadable remote default asks unless the grant names this exact branch (fail closed)", async () => {
  const any = setup([pushGrant], remote("https://h/x.git", ""));
  expect(await gitPush(any.ctx, push("feat/x"))).toMatchObject({ code: "OWNER_DENIED" });
  expect(any.asked).toHaveLength(1);
  expect(any.calls.some((c) => c.startsWith("git push"))).toBe(false);
  const named: EffectGrant = { tool: GIT_PUSH_TOOL, scope: { location: "api", branch: "feat/x" } };
  const exact = setup([named], remote("https://h/x.git", ""));
  expect(await gitPush(exact.ctx, push("feat/x"))).toMatchObject({ ok: true });
  expect(exact.asked).toHaveLength(0);
});

test("L4 merge: an unset origin/HEAD asks unless the grant names this exact target (fail closed)", async () => {
  const noOrigin = (script: ReturnType<typeof mergeScript>) => (cmd: string) =>
    cmd.includes("symbolic-ref") ? { code: 1, out: "" } : script(cmd);
  const any = setup([mergeGrant], noOrigin(mergeScript({ pending: false, conflict: false })));
  expect(await mergeBranch(any.ctx, mergeInput)).toMatchObject({ code: "OWNER_DENIED" });
  expect(any.asked).toHaveLength(1);
  const named: EffectGrant = {
    tool: MERGE_BRANCH_TOOL,
    scope: { location: "api", into: "integration" },
  };
  const exact = setup([named], noOrigin(mergeScript({ pending: false, conflict: false })));
  expect(await mergeBranch(exact.ctx, mergeInput)).toMatchObject({ code: "MERGE_FAILED" }); // asked nothing, the fake merge conflicts
  expect(exact.asked).toHaveLength(0);
});
