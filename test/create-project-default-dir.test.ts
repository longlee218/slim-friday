import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { REGISTER_LOCATION_SHAPE } from "../src/orchestrator/lead/lead-schemas";
import { defaultProjectPath, slugify } from "../src/workspaces/default-project-path";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { makeEnv, tempDirs } from "./helpers";
import { type Call, leadHarness, until } from "./lead-harness";

/* register_location create:true without a path: the new project goes under the channel's (else the workspace's) default projectsDir. */

const SAVED = { ...process.env };
const GIT_DIR = String.fromCharCode(46) + "git";
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "friday-cpd-")));
  tempDirs.push(base);
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

/** Set `projectsDir` on the workspace and/or the test channel entry of workspace "main". */
function setDirs(env: ReturnType<typeof makeEnv>, dirs: { ws?: string; channel?: string }) {
  const file = env.paths.workspace("main").config;
  const doc = Bun.YAML.parse(readFileSync(file, "utf8")) as any;
  if (dirs.ws) doc.projectsDir = dirs.ws;
  if (dirs.channel) doc.channels[0].projectsDir = dirs.channel;
  writeFileSync(file, Bun.YAML.stringify(doc));
}

/** Run one register_location call as the lead and return its reply. */
async function register(env: ReturnType<typeof makeEnv>, input: object, say: string) {
  let reg: any;
  const h = leadHarness(
    async (c: Call) => {
      if (c.kind === "lead") reg = await c.orchestrate("register_location", input);
      return "ok";
    },
    env,
    {},
  );
  await h.send(say);
  await until(() => reg !== undefined);
  return reg;
}

test("no path: default dir + slug of the name, README keeps the request", async () => {
  const env = makeEnv();
  const dir = join(base, "projects");
  mkdirSync(dir);
  setDirs(env, { channel: dir });
  const reg = await register(env, { create: true, name: "Todo App!" }, "build me a todo app");
  expect(reg).toMatchObject({
    ok: true,
    location: "todo-app",
    path: join(dir, "todo-app"),
    created: true,
  });
  expect(readFileSync(join(dir, "todo-app", "README.md"), "utf8")).toContain("build me a todo app");
});

test("name omitted: slug comes from the request", async () => {
  const env = makeEnv();
  const dir = join(base, "projects");
  mkdirSync(dir);
  setDirs(env, { ws: dir });
  const reg = await register(env, { create: true }, "Build a Habit tracker please now");
  expect(reg).toMatchObject({ ok: true, path: join(dir, "build-a-habit-tracker") });
});

test("a taken name gets -2, then -3", async () => {
  const env = makeEnv();
  const dir = join(base, "projects");
  for (const n of ["app", "app-2"]) {
    mkdirSync(join(dir, n), { recursive: true });
    writeFileSync(join(dir, n, "x"), "1");
  }
  setDirs(env, { ws: dir });
  const reg = await register(env, { create: true, name: "app" }, "make app");
  expect(reg).toMatchObject({ ok: true, path: join(dir, "app-3") });
});

test("owner path wins over the default dir", async () => {
  const env = makeEnv();
  const dir = join(base, "projects");
  mkdirSync(dir);
  setDirs(env, { ws: dir });
  const own = join(base, "mine");
  const reg = await register(env, { create: true, path: own }, `make ${own}`);
  expect(reg).toMatchObject({ ok: true, path: own });
  expect(existsSync(join(dir, "mine"))).toBe(false);
});

test("owner path not in the message is refused even with a default dir", async () => {
  const env = makeEnv();
  const dir = join(base, "projects");
  mkdirSync(dir);
  setDirs(env, { ws: dir });
  const sneaky = join(base, "sneaky");
  const reg = await register(env, { create: true, path: sneaky }, "build me an app");
  expect(reg).toMatchObject({ ok: false, code: "PATH_NOT_IN_MESSAGE" });
  expect(existsSync(sneaky)).toBe(false);
});

test("no default and no path: project under <home>/projects, dir auto-created, no ask", async () => {
  const env = makeEnv();
  const dir = env.paths.projects;
  expect(existsSync(dir)).toBe(false);
  const reg = await register(env, { create: true, name: "app" }, "build an app");
  expect(reg).toMatchObject({ ok: true, location: "app", path: join(realpathSync(dir), "app") });
  expect(existsSync(join(dir, "app", GIT_DIR))).toBe(true);
});

test("a configured dir wins over <home>/projects", async () => {
  const env = makeEnv();
  const dir = join(base, "mine-dir");
  mkdirSync(dir);
  setDirs(env, { ws: dir });
  const reg = await register(env, { create: true, name: "app" }, "build an app");
  expect(reg).toMatchObject({ ok: true, path: join(dir, "app") });
  expect(existsSync(env.paths.projects)).toBe(false);
});

test("channel default overrides the workspace default", async () => {
  const env = makeEnv();
  const wsDir = join(base, "ws-dir");
  const chDir = join(base, "ch-dir");
  mkdirSync(wsDir);
  mkdirSync(chDir);
  setDirs(env, { ws: wsDir, channel: chDir });
  const reg = await register(env, { create: true, name: "app" }, "make app");
  expect(reg).toMatchObject({ ok: true, path: join(chDir, "app") });
});

test("a default dir that does not exist is refused with BAD_DEFAULT_PROJECTS_DIR", async () => {
  const env = makeEnv();
  setDirs(env, { ws: join(base, "missing") });
  const reg = await register(env, { create: true, name: "app" }, "make app");
  expect(reg).toMatchObject({ ok: false, code: "BAD_DEFAULT_PROJECTS_DIR" });
});

test("guards still apply to the default dir (inside a git repo, outside home)", async () => {
  const env = makeEnv();
  const repo = join(base, "repo");
  mkdirSync(join(repo, GIT_DIR), { recursive: true });
  setDirs(env, { ws: repo });
  expect(await register(env, { create: true, name: "app" }, "make app")).toMatchObject({
    ok: false,
    code: "INSIDE_GIT_REPO",
  });
  const env2 = makeEnv();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "friday-cpd-out-")));
  tempDirs.push(outside);
  setDirs(env2, { ws: outside });
  expect(await register(env2, { create: true, name: "app" }, "make app")).toMatchObject({
    ok: false,
    code: "OUTSIDE_HOME",
  });
});

test("~/ default dir expands against the owner's home", () => {
  mkdirSync(join(base, "p"));
  expect(defaultProjectPath("~/p", base, "x", "req")).toEqual({
    ok: true,
    path: join(base, "p", "x"),
  });
});

test("slugify: kebab-case, capped at 40, no edge dashes", () => {
  expect(slugify("  Hello, World_1 ")).toBe("hello-world-1");
  expect(slugify("a".repeat(60))).toHaveLength(40);
  expect(slugify("???")).toBe("");
});

test("schema: projectsDir is read from workspace.yaml (channel and workspace); empty is rejected", () => {
  const env = makeEnv();
  setDirs(env, { ws: "~/w", channel: "/abs/c" });
  const ws = loadWorkspaces(env.home, base).workspaces.find((w) => w.name === "main");
  expect(ws?.projectsDir).toBe("~/w");
  expect(ws?.channelDefs[0]?.projectsDir).toBe("/abs/c");
  writeFileSync(env.paths.workspace("main").config, "projectsDir: ''\nchannels: []\n");
  expect(loadWorkspaces(env.home, base).workspaces.some((w) => w.name === "main")).toBe(false);
});

test("register_location schema: name max 40, path optional", () => {
  const s = z.object(REGISTER_LOCATION_SHAPE);
  expect(s.safeParse({ create: true }).success).toBe(true);
  expect(s.safeParse({ create: true, name: "x".repeat(41) }).success).toBe(false);
});

test("slugify: accents and đ are folded, not dropped", () => {
  expect(slugify("tạo game cờ vua Đẹp")).toBe("tao-game-co-vua-dep");
});
