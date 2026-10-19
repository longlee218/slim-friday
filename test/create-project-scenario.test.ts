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
import { createProject } from "../src/workspaces/create-project";
import { makeEnv, tempDirs } from "./helpers";
import { type Call, leadHarness, until } from "./lead-harness";

/* Orchestrate register_location with create: true. The temp dir stands in for $HOME (os.homedir reads HOME); git identity from env. */

const SAVED = { ...process.env };
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "friday-cp-")));
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

/** Lead script: ask_owner select (the answer is the path), then register_location create, then dispatch to the new location. */
function createFlow(_path: string, out: { ask?: any; reg?: any; dispatch?: any }) {
  return async (c: Call) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
      return "ok";
    }
    if (c.prompt.includes("Owner message:") && !out.reg) {
      out.ask = await c.orchestrate("ask_owner", {
        kind: "select",
        question: "Where?",
        options: ["~/newapp", "~/newapp-b"],
      });
      out.reg = await c.orchestrate("register_location", { path: "~/newapp", create: true });
      if (out.reg.ok)
        out.dispatch = await c.orchestrate("dispatch", {
          strategy: "DIRECT",
          intent: "build",
          reason: "r",
          assignments: [
            {
              key: "main",
              subject: "Build it",
              role: "developer",
              brief: "do it",
              location: out.reg.location,
              dependsOn: [],
            },
          ],
        });
    }
    return "ok";
  };
}

test("answer is the approval: created, committed, registered, dispatchable in the same run", async () => {
  const env = makeEnv();
  const path = join(base, "newapp");
  const out: { ask?: any; reg?: any; dispatch?: any } = {};
  let asked = 0;
  const h = leadHarness(createFlow(path, out), env, {
    askChoice: async () => {
      asked++;
      return "~/newapp";
    },
  });
  await h.send("build me a todo app");
  await until(() => out.reg !== undefined);
  await until(() => out.dispatch !== undefined);
  expect(asked).toBe(1); // only ask_owner, no Yes/No
  expect(out.reg).toMatchObject({ ok: true, location: "newapp", created: true, linked: true });
  expect(out.dispatch).toMatchObject({ ok: true });
  expect(readFileSync(join(path, "README.md"), "utf8")).toContain("build me a todo app");
  const log = Bun.spawnSync(["git", "log", "--format=%an <%ae>|%s"], { cwd: path });
  expect(log.stdout.toString().trim()).toBe("Owner <owner@example.com>|Initial commit");
});

test("path the owner never wrote or chose is refused and nothing is created", async () => {
  const env = makeEnv();
  const path = join(base, "sneaky");
  let reg: any;
  const h = leadHarness(
    async (c: Call) => {
      if (c.kind === "lead") reg = await c.orchestrate("register_location", { path, create: true });
      return "ok";
    },
    env,
    {},
  );
  await h.send("build me a todo app");
  await until(() => reg !== undefined);
  expect(reg).toMatchObject({ ok: false, code: "PATH_NOT_IN_MESSAGE" });
  expect(existsSync(path)).toBe(false);
});

test("the owner's message alone is enough for an owner-typed path (no ask_owner)", async () => {
  const env = makeEnv();
  const path = join(base, "msgonly");
  let reg: any;
  const h = leadHarness(
    async (c: Call) => {
      if (c.kind === "lead") reg = await c.orchestrate("register_location", { path, create: true });
      return "ok";
    },
    env,
    {},
  );
  await h.send(`make ${path}`);
  await until(() => reg !== undefined);
  expect(reg).toMatchObject({ ok: true, created: true });
  expect(existsSync(path)).toBe(true);
});

test("one create per run", async () => {
  const env = makeEnv();
  const a = join(base, "a");
  const b = join(base, "b");
  const replies: any[] = [];
  const answers = [a, b];
  const h = leadHarness(
    async (c: Call) => {
      if (c.kind === "lead") {
        for (const p of [a, b]) {
          await c.orchestrate("ask_owner", {
            kind: "select",
            question: `Where ${p}?`,
            options: [a, b],
          });
          replies.push(await c.orchestrate("register_location", { path: p, create: true }));
        }
      }
      return "ok";
    },
    env,
    { askChoice: async () => answers.shift() as string },
  );
  await h.send(`make ${a} and ${b}`);
  await until(() => replies.length === 2);
  expect(replies[0]).toMatchObject({ ok: true });
  expect(replies[1]).toMatchObject({ ok: false, code: "LIMIT" });
  expect(existsSync(b)).toBe(false);
});

/** createProject with $HOME = `base` and an agent home elsewhere. */
const run = async (path: string, home = join(base, "agent")) => {
  mkdirSync(home, { recursive: true });
  return createProject(home, base, path, "req");
};

test("guards: each refusal has its code", async () => {
  mkdirSync(join(base, "full"));
  writeFileSync(join(base, "full", "x"), "1");
  mkdirSync(join(base, "repo", ".git"), { recursive: true });
  expect(await run(join(base, "no-parent", "p"))).toMatchObject({ code: "PARENT_MISSING" });
  expect(await run(join(tmpdir(), "outside-home-x"))).toMatchObject({ code: "OUTSIDE_HOME" });
  expect(await run(base)).toMatchObject({ code: "OUTSIDE_HOME" });
  expect(await run(join(base, "agent", "p"))).toMatchObject({ code: "INSIDE_AGENT_HOME" });
  expect(await run(join(base, ".ssh", "p"))).toMatchObject({ code: "PARENT_MISSING" });
  mkdirSync(join(base, ".ssh"));
  expect(await run(join(base, ".ssh", "p"))).toMatchObject({ code: "CREDENTIAL_DIR" });
  expect(await run(join(base, "full"))).toMatchObject({ code: "PATH_EXISTS" });
  expect(await run(join(base, "repo", "p"))).toMatchObject({ code: "INSIDE_GIT_REPO" });
  expect(await run("relative/p")).toMatchObject({ code: "BAD_PATH" });
});

test("no git identity is refused before anything is made", async () => {
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"]) delete process.env[k];
  const noIdentity = async (cmd: string[]) =>
    cmd[1] === "config" ? { code: 1, out: "" } : { code: 0, out: "" };
  mkdirSync(join(base, "agent"));
  const r = await createProject(join(base, "agent"), base, join(base, "p"), "req", noIdentity);
  expect(r).toMatchObject({ ok: false, code: "NO_GIT_IDENTITY" });
  expect(existsSync(join(base, "p"))).toBe(false);
});

test("an empty existing dir is accepted", async () => {
  mkdirSync(join(base, "empty"));
  expect(await run(join(base, "empty"))).toEqual({
    ok: true,
    path: join(base, "empty"),
    made: false,
  });
});
