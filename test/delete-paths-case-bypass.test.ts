import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePaths } from "../src/mcp/effects/delete-paths";
import type { EffectsCtx } from "../src/orchestrator/approval/effect-context";
import { defaultEnvelope } from "../src/orchestrator/approval/envelope";
import { openDb } from "../src/storage/db";

/* DeletePaths on a case-insensitive volume (macOS APFS default). realpath canonicalizes the case of EXISTING parents,
   but the final entry name is taken as typed: a case variant of the last name is checked against case-sensitive rules.
   The controls (lower case) must be refused; the DEFECT rows must be refused too and fail until the rules are case-folded. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "delete-case-")));

/** A location `loc` in the envelope, AGENT_HOME `home` (scratch under it). Confirm always answers no. */
function ctxFor(loc: string, home: string): EffectsCtx {
  const scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  return {
    db: openDb(join(home, "t.db")),
    threadId: "t1",
    goalId: "goal-case",
    itemId: "item-1",
    envelope: defaultEnvelope("goal-case", ["loc"], scratch),
    locations: [{ name: "loc", path: loc }],
    agentHome: home,
    confirm: async () => false,
    run: async () => ({ code: 0, out: "" }),
    now: () => 1_000_000_000_000,
  };
}

/** A fresh location with a git dir (`.git`) and a home; returns the paths and the ctx. */
function fresh(tag: string) {
  const loc = join(base, `${tag}-loc`);
  const home = join(base, `${tag}-home`);
  mkdirSync(join(loc, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(loc, ".git", "HEAD"), "ref: refs/heads/main\n");
  return { loc, home, ctx: ctxFor(loc, home) };
}

test("control: the lower-case git dir of a location is refused, nothing moves", async () => {
  const s = fresh("ctl-git");
  const r = await deletePaths(s.ctx, { paths: [join(s.loc, ".git")], reason: "t" });
  expect(r.ok).toBe(false);
  expect(existsSync(join(s.loc, ".git", "HEAD"))).toBe(true);
});

test("DEFECT: the git dir spelled `.GIT` (same dir on macOS) must be refused", async () => {
  const s = fresh("case-git");
  const r = await deletePaths(s.ctx, { paths: [join(s.loc, ".GIT")], reason: "t" });
  expect(r.ok).toBe(false);
  expect(existsSync(join(s.loc, ".git", "HEAD"))).toBe(true);
});

test("control: a lower-case secret name (.env) is refused", async () => {
  const s = fresh("ctl-env");
  writeFileSync(join(s.loc, ".env"), "KEY=1");
  const r = await deletePaths(s.ctx, { paths: [join(s.loc, ".env")], reason: "t" });
  expect(r.ok).toBe(false);
  expect(existsSync(join(s.loc, ".env"))).toBe(true);
});

test("DEFECT: secret names in another case (.ENV, ID_RSA) must be refused", async () => {
  const s = fresh("case-secret");
  for (const name of [".ENV", "ID_RSA"]) writeFileSync(join(s.loc, name), "secret");
  for (const name of [".ENV", "ID_RSA"]) {
    const r = await deletePaths(s.ctx, { paths: [join(s.loc, name)], reason: "t" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(s.loc, name))).toBe(true);
  }
});
