import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWorkspaceDir } from "../src/discord-setup/workspace-template";
import type { LeadPlace } from "../src/orchestrator/lead/lead-call";
import { handleRegisterLocation } from "../src/orchestrator/lead/lead-location-handler";
import { createProject } from "../src/workspaces/create-project";
import { inspectLocation } from "../src/workspaces/location-candidate";
import { registerLocation } from "../src/workspaces/register-location";
import { tempDirs } from "./helpers";
import { FakePort, leadCtx } from "./lead-fake-port";

/* Guards of `register_location create: true` not covered by create-project-scenario.test.ts: a path inside an existing
   location, a git failure rolls back only what the call made, a NUL byte, and an announce run never creates. */

const SAVED = { ...process.env };
const CH = "100000000000000002";
let base: string;
let home: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "friday-cpg-")));
  tempDirs.push(base);
  home = join(base, "agent");
  mkdirSync(home, { recursive: true });
  process.env.HOME = base;
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "Owner",
    GIT_AUTHOR_EMAIL: "owner@example.com",
    GIT_COMMITTER_NAME: "Owner",
    GIT_COMMITTER_EMAIL: "owner@example.com",
  });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

/** Git stand-in: identity answers, and `git commit` fails the way a rejecting hook would. */
const commitRefused = async (cmd: string[]) =>
  cmd[1] === "commit" ? { code: 1, out: "hook rejected\n" } : { code: 0, out: "owner" };

test("a path inside an existing location is INSIDE_LOCATION (the location is a plain dir, not a repo)", async () => {
  // A workspace "w" with channel CH and one registered location: base/loc (empty, no .git).
  createWorkspaceDir(home, "w");
  writeFileSync(
    workspacePaths(home).workspace("w").config,
    `channels:\n  - id: "${CH}"\n    name: c\n    mode: task\n`,
  );
  const loc = join(base, "loc");
  mkdirSync(loc);
  const c = inspectLocation(home, "w", loc, base);
  expect(c.ok).toBe(true);
  if (!c.ok) return;
  expect(registerLocation(home, "w", CH, c, base).ok).toBe(true);
  expect(await createProject(home, base, join(loc, "newapp"), "req")).toMatchObject({
    ok: false,
    code: "INSIDE_LOCATION",
  });
  expect(existsSync(join(loc, "newapp"))).toBe(false);
});

test("a git failure removes the directory this call made and nothing else", async () => {
  const made = join(base, "made");
  expect(await createProject(home, base, made, "req", commitRefused)).toMatchObject({
    ok: false,
    code: "CREATE_FAILED",
  });
  expect(existsSync(made)).toBe(false);

  // A pre-existing empty folder is the owner's: a failed create leaves it in place.
  const kept = join(base, "kept");
  mkdirSync(kept);
  expect(await createProject(home, base, kept, "req", commitRefused)).toMatchObject({
    code: "CREATE_FAILED",
  });
  expect(existsSync(kept)).toBe(true);
  expect(readdirSync(kept)).toEqual([]); // the README and the git dir this call wrote are removed again
});

test("a symlink as the final component is PATH_IS_SYMLINK (dangling, or to an empty dir) and is never followed", async () => {
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(join(base, "missing-target"), join(base, "dangling"));
  symlinkSync(elsewhere, join(base, "to-empty"));
  for (const name of ["dangling", "to-empty"])
    expect(await createProject(home, base, join(base, name), "req")).toMatchObject({
      ok: false,
      code: "PATH_IS_SYMLINK",
    });
  expect(readdirSync(elsewhere)).toEqual([]); // nothing written through the link
  expect(existsSync(join(base, "missing-target"))).toBe(false);
});

test("a path that appears between the guard and mkdir (not empty) is PATH_EXISTS and is never removed", async () => {
  const raced = join(base, "raced");
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"]) delete process.env[k]; // so the identity check calls the runner
  // The git-identity check runs after the guard and before mkdir: the owner's folder shows up right there.
  const racing = async (cmd: string[]) => {
    if (cmd[1] === "config" && !existsSync(raced)) {
      mkdirSync(raced);
      writeFileSync(join(raced, "mine.txt"), "keep");
    }
    return { code: 0, out: "owner" };
  };
  expect(await createProject(home, base, raced, "req", racing)).toMatchObject({
    ok: false,
    code: "PATH_EXISTS",
  });
  expect(readdirSync(raced)).toEqual(["mine.txt"]);
});

test("a create that cannot be registered removes the dir it made", async () => {
  const port = new FakePort();
  const ctx = leadCtx(port);
  const target = join(base, "orphan");
  // No workspace "w" exists, so the register step fails after the project was created.
  ctx.place = {
    home,
    workspace: "w",
    channel: "c",
    channelId: CH,
    trigger: "owner",
    ownerText: `make ${target}`,
    refresh: () => {},
  } as LeadPlace;
  ctx.run.ownerAnswers = [target];
  const r = await handleRegisterLocation(ctx, { path: target, create: true }, base);
  expect(r).toMatchObject({ ok: false });
  expect((r as { code: string }).code).toMatch(/^(BAD_PATH|WRITE_FAILED)$/); // refused after the create, not by a guard
  expect(existsSync(target)).toBe(false);
});

test("a path with a NUL byte is BAD_PATH and nothing is created", async () => {
  const r = await createProject(home, base, `${join(base, "x")}\0y`, "req");
  expect(r).toMatchObject({ ok: false, code: "BAD_PATH" });
  expect(existsSync(join(base, "x"))).toBe(false);
});

test("an announce run (worker text) with create: true is NOT_OWNER_TURN: nothing asked, nothing created", async () => {
  const port = new FakePort();
  const ctx = leadCtx(port);
  const target = join(base, "fromworker");
  ctx.place = {
    home,
    workspace: "w",
    channel: "c",
    channelId: CH,
    trigger: "announce",
    // The worker's text names the path: only the trigger check may refuse it (the owner-words check would pass).
    ownerText: `create ${target}`,
    refresh: () => {},
  } as LeadPlace;
  const r = await handleRegisterLocation(ctx, { path: target, create: true }, base);
  expect(r).toMatchObject({ ok: false, code: "NOT_OWNER_TURN" });
  expect(port.asked).toEqual([]);
  expect(existsSync(target)).toBe(false);
});
