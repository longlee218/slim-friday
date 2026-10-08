import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createGitMcp } from "../src/mcp/git-mcp";
import { getWorktreeByThread } from "../src/storage/worktree-store";
import { createTaskHandler } from "../src/tasks/handle-task";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { setupWorkflow } from "./code-flow-fixture";
import { BRIEF, delegatingQuery, initMsg, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

/** The real git MCP server (pinned package), shared by the tests of this file. */
const git = createGitMcp();
afterAll(() => git.close());

/** Run a delegated task to the end of the exec stage; return the options of the plan and exec runs. */
async function runTask(config: Record<string, string>, skills: string[]) {
  const { env, clone } = await setupWorkflow(config, skills);
  const seen: any[] = [];
  /** Plugin dir listing at exec start (the app removes the dir when the run ends). */
  let pluginFiles: string[] = [];
  const next = (a: any) => {
    seen.push(a.options);
    const pdir = a.options.plugins?.[0]?.path;
    if (pdir) pluginFiles = (readdirSync(pdir, { recursive: true }) as string[]).sort();
    return (async function* () {
      yield initMsg;
      if (a.options.permissionMode === "plan") {
        const p = await a.options.canUseTool(
          EXIT_PLAN_MODE_TOOL_NAME,
          { plan: "repo: real\nx" },
          {},
        );
        if (p.behavior === "allow") throw new Error("process aborted");
        return;
      }
      yield resultMsg({ result: "done" });
    })();
  };
  const handle = createTaskHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ confirm: async () => ({ approved: false, reason: "no" }) }),
    queryFn: delegatingQuery([{ brief: BRIEF }], next) as never,
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "change it",
  });
  const [plan, exec] = seen;
  return { env, clone, plan, exec, pluginFiles, wt: getWorktreeByThread(env.db, "th1")! };
}

test("lean (default): exec loads no skills and no plugins, no full rules", async () => {
  const { plan, exec } = await runTask({}, ["deploy"]);
  expect(exec.skills).toEqual([]);
  expect(exec.plugins).toBeUndefined();
  expect(exec.settingSources).toEqual([]);
  for (const o of [plan, exec]) {
    expect(o.systemPrompt.append).not.toContain("workflow: full");
    expect(o.systemPrompt.append).toContain("ONE"); // the ask boundary applies to every code task
  }
});

test("full: exec lists the clone's skills through an app-owned plugin copy, not the worktree", async () => {
  const { clone, plan, exec, wt, pluginFiles } = await runTask({ workflow: "full" }, [
    "deploy",
    "review",
  ]);
  const pdir: string = exec.plugins[0].path;
  expect(exec.plugins).toEqual([{ type: "local", path: pdir }]);
  expect(exec.skills.sort()).toEqual(["real:deploy", "real:review"]); // workspace name = plugin name
  // Neither the clone's .claude nor the worktree: the plugin dir is the app's own copy.
  expect(pdir.startsWith(realpathSync(clone))).toBe(false);
  expect(pdir.startsWith(realpathSync(wt.path))).toBe(false);
  expect(pluginFiles).toEqual(
    [
      ".claude-plugin",
      ".claude-plugin/plugin.json",
      "skills",
      "skills/deploy",
      "skills/deploy/SKILL.md",
      "skills/review",
      "skills/review/SKILL.md",
    ].sort(),
  );
  expect(existsSync(pdir)).toBe(false); // removed with the run
  expect(exec.settingSources).toEqual([]); // the worktree's own .claude is still never loaded
  expect(exec.cwd).toBe(realpathSync(wt.path));
  expect(plan.systemPrompt.append).toContain("[workflow: full]");
  expect(exec.systemPrompt.append).toContain("This repo is [workflow: full]");
  expect(exec.systemPrompt.append).toContain("Assumptions");
});

test("full without skills in the clone: no plugin, skills stay empty", async () => {
  const { exec } = await runTask({ workflow: "full" }, []);
  expect(exec.plugins).toBeUndefined();
  expect(exec.skills).toEqual([]);
});

test("full: the clone is readable in the exec guard but never writable", async () => {
  const { clone, exec } = await runTask({ workflow: "full" }, ["deploy"]);
  const skillFile = join(realpathSync(clone), ".claude", "skills", "deploy", "SKILL.md");
  const lean = await runTask({}, ["deploy"]);
  const read = (o: any, p: string) => o.canUseTool("Read", { file_path: p }, {});
  expect((await read(exec, skillFile)).behavior).toBe("allow");
  expect((await read(lean.exec, join(realpathSync(lean.clone), "a.txt"))).behavior).not.toBe(
    "allow",
  );
  const write = await exec.canUseTool("Write", { file_path: skillFile, content: "x" }, {});
  expect(write.behavior).toBe("deny");
});
