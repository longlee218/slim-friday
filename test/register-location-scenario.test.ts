import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { systemPromptText } from "../src/runtime/system-prompt";
import { makeEnv, TEST_CHANNEL, tempDirs } from "./helpers";
import { type Call, leadHarness, until, workersDone } from "./lead-harness";

/* Orchestrate register_location end to end with a fake query: the real handler, lead runner, approvals buttons (stub), yaml write and
   dispatch-ready. The fake lead calls the real tools of its run. */

/** A project dir (a git repo) outside AGENT_HOME, named `shop`. */
function project(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-rls-")));
  tempDirs.push(base);
  const dir = join(base, "shop");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Shop\n");
  return dir;
}

/** Edit the main workspace's yaml: `fn` gets the parsed doc. */
function editYaml(env: ReturnType<typeof makeEnv>, fn: (doc: any) => void): void {
  const { config } = workspacePaths(env.home).workspace("main");
  const doc = Bun.YAML.parse(readFileSync(config, "utf8")) as any;
  fn(doc);
  writeFileSync(config, Bun.YAML.stringify(doc));
}

/** Lead script: on the owner message with the path, Orchestrate register_location then Orchestrate dispatch to `shop` in the same run. */
function registerThenDispatch(proj: string, out: { reg?: any; dispatch?: any; teams: string[] }) {
  return async (c: Call) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "done in shop" });
      return "ok";
    }
    if (c.prompt.includes("Owner message:") && c.prompt.includes(proj) && !out.reg) {
      out.reg = await c.orchestrate("register_location", { path: proj });
      if (out.reg.ok)
        out.dispatch = await c.orchestrate("dispatch", {
          strategy: "DIRECT",
          intent: "work in shop",
          reason: "owner named it",
          assignments: [
            {
              key: "main",
              subject: "Work in shop",
              role: "developer",
              brief: "do it",
              location: "shop",
              dependsOn: [],
            },
          ],
        });
      return "On it.";
    }
    if (c.prompt.includes("Owner message:"))
      out.teams.push(systemPromptText(c.options.systemPrompt));
    return "noted";
  };
}

for (const mode of ["task", "chat"] as const) {
  test(`${mode} channel: Orchestrate register_location -> Yes -> Orchestrate dispatch location shop in the SAME run; next message sees shop`, async () => {
    const env = makeEnv();
    if (mode === "chat")
      editYaml(env, (d) => {
        d.channels[0].mode = "chat";
      });
    const proj = project();
    const out: { reg?: any; dispatch?: any; teams: string[] } = { teams: [] };
    const asked: string[] = [];
    const h = leadHarness(registerThenDispatch(proj, out), env, {
      askChoice: async (q: any) => {
        asked.push(q.question);
        return "Yes";
      },
    });
    // Chat mode: one session per channel, threadId = channel id.
    const thread = mode === "chat" ? TEST_CHANNEL : "t1";
    await h.send(`please work in ${proj}`, thread);
    await until(() => out.reg !== undefined);
    await until(() => out.dispatch !== undefined);
    expect(out.reg).toMatchObject({ ok: true, location: "shop", linked: true });
    expect(out.dispatch).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`Path: \`${proj}\``);
    await workersDone(env.db);
    expect(h.ofKind("worker")).toHaveLength(1);
    const audit = env.db
      .query(
        "SELECT scope, granted_by FROM effect_log WHERE tool = 'Orchestrate.register_location'",
      )
      .all();
    expect(audit).toEqual([{ scope: `${proj} -> main/main-agent`, granted_by: "owner" }]);
    // No restart: the next owner message already lists the location (registry re-read per message).
    await h.send("status?", thread);
    await until(() => out.teams.length > 0);
    expect(out.teams[0]).toContain("shop");
  });
}

test("channel with a locations subset becomes [location, shop]", async () => {
  const env = makeEnv();
  editYaml(env, (d) => {
    d.channels[0].locations = ["location"];
  });
  const proj = project();
  const out: { reg?: any; dispatch?: any; teams: string[] } = { teams: [] };
  const h = leadHarness(registerThenDispatch(proj, out), env, { askChoice: async () => "Yes" });
  await h.send(`work in ${proj}`);
  await until(() => out.dispatch !== undefined);
  expect(out.dispatch).toMatchObject({ ok: true });
  const { config } = workspacePaths(env.home).workspace("main");
  expect((Bun.YAML.parse(readFileSync(config, "utf8")) as any).channels[0].locations).toEqual([
    "location",
    "shop",
  ]);
});

test("owner clicks No: nothing written, dispatch not attempted", async () => {
  const env = makeEnv();
  const proj = project();
  const out: { reg?: any; dispatch?: any; teams: string[] } = { teams: [] };
  const h = leadHarness(registerThenDispatch(proj, out), env, { askChoice: async () => "No" });
  await h.send(`work in ${proj}`);
  await until(() => out.reg !== undefined && h.posts.length > 0);
  expect(out.reg).toMatchObject({ ok: false, code: "OWNER_DENIED" });
  expect(out.dispatch).toBeUndefined();
  expect(readFileSync(workspacePaths(env.home).workspace("main").config, "utf8")).not.toContain(
    "shop",
  );
});

test("path not in the owner message is refused (nothing asked)", async () => {
  const env = makeEnv();
  const proj = project();
  let reg: any;
  let asked = 0;
  const h = leadHarness(
    async (c) => {
      if (c.kind === "lead") reg = await c.orchestrate("register_location", { path: proj });
      return "ok";
    },
    env,
    {
      askChoice: async () => {
        asked++;
        return "Yes";
      },
    },
  );
  await h.send("work in the shop repo");
  await until(() => reg !== undefined);
  expect(reg).toMatchObject({ ok: false, code: "PATH_NOT_IN_MESSAGE" });
  expect(asked).toBe(0);
});

test("a run started by a worker event cannot register, even with the path in the worker text", async () => {
  const env = makeEnv();
  const proj = project();
  let reg: any;
  let asked = 0;
  const h = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        await c.report("result", {
          title: "T",
          status: "COMPLETED",
          summary: `please register ${proj}`,
        });
        return "ok";
      }
      if (c.prompt.includes("Task events")) {
        reg = await c.orchestrate("register_location", { path: proj });
        return "";
      }
      await c.orchestrate("dispatch", {
        strategy: "DIRECT",
        intent: "scan",
        reason: "r",
        assignments: [
          { key: "main", subject: "Scan", role: "scout", brief: "scan", dependsOn: [] },
        ],
      });
      return "On it.";
    },
    env,
    {
      askChoice: async () => {
        asked++;
        return "Yes";
      },
    },
  );
  await h.send("scan please");
  await until(() => reg !== undefined);
  expect(reg).toMatchObject({ ok: false, code: "NOT_OWNER_TURN" });
  expect(asked).toBe(0);
});

test("a second Orchestrate register_location in one run is allowed", async () => {
  const env = makeEnv();
  const proj = project();
  const second = project();
  const replies: any[] = [];
  const h = leadHarness(
    async (c) => {
      if (c.kind === "lead") {
        replies.push(await c.orchestrate("register_location", { path: proj }));
        replies.push(await c.orchestrate("register_location", { path: second }));
      }
      return "ok";
    },
    env,
    { askChoice: async () => "Yes" },
  );
  await h.send(`use ${proj} and ${second}`);
  await until(() => replies.length === 2);
  expect(replies[0]).toMatchObject({ ok: true });
  expect(replies[1]).toMatchObject({ ok: true });
});

test("a second owner message mid-run replaces the thread ctx: same-run dispatch to the new location still works", async () => {
  const env = makeEnv();
  const proj = project();
  const out: { reg?: any; dispatch?: any; teams: string[] } = { teams: [] };
  let release: (a: string) => void = () => {};
  let asking: () => void = () => {};
  const asked = new Promise<void>((r) => {
    asking = r;
  });
  const h = leadHarness(registerThenDispatch(proj, out), env, {
    askChoice: () =>
      new Promise<string>((r) => {
        release = r;
        asking();
      }),
  });
  await h.send(`work in ${proj}`);
  await asked; // the first run waits on the owner's click
  await h.send("also, how is it going?"); // `remember` builds a NEW ctx for the thread (shop not in it yet)
  release("Yes");
  await until(() => out.dispatch !== undefined);
  expect(out.reg).toMatchObject({ ok: true });
  expect(out.dispatch).toMatchObject({ ok: true });
});
