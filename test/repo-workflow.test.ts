import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitMcp } from "../src/mcp/git-mcp";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { getWorktreeByThread } from "../src/storage/worktree-store";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { setupWorkflow } from "./code-flow-fixture";
import { devIntent, initMsg, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

/** The real git MCP server (pinned package), shared by the tests of this file. */
const git = createGitMcp();
afterAll(() => git.close());

/** Skills the dev role gets from its Superpowers set (plan stage; exec adds the three subagent skills). */
const SP = [
  "brainstorming",
  "executing-plans",
  "systematic-debugging",
  "test-driven-development",
  "verification-before-completion",
  "writing-plans",
].map((k) => `superpowers:${k}`);
/** The exec stage also loads the subagent skills (its subagent list has implementer and task-reviewer). */
const SDD_SKILLS = [
  "subagent-driven-development",
  "requesting-code-review",
  "receiving-code-review",
].map((k) => `superpowers:${k}`);
/** The skills of a plan run as sorted names: the set's plus the given workspace ones. */
const withSet = (...ws: string[]) => [...SP, ...ws].sort();
/** Same for the exec run (set + subagent skills + workspace ones). */
const withExec = (...ws: string[]) => [...SP, ...SDD_SKILLS, ...ws].sort();

/** Run a dev task to the end of the exec stage; return the options of the plan and exec runs. */
async function runTask(
  config: Record<string, string>,
  skills: string[],
  prep?: (clone: string) => void,
  repoSkills: string[] = [],
  /** Called with the options of each stage while its run is alive (plugin dirs exist), e.g. to probe canUseTool. */
  probe?: (o: any) => Promise<void>,
) {
  const { env, clone } = await setupWorkflow(config, skills, repoSkills);
  prep?.(clone);
  const seen: any[] = [];
  /** Plugin dir listing at exec start (the app removes the dir when the run ends). */
  let pluginFiles: string[] = [];
  const next = (a: any) => {
    seen.push(a.options);
    const pdir = a.options.plugins?.at(-1)?.path; // the workspace plugin is built last
    if (pdir) pluginFiles = (readdirSync(pdir, { recursive: true }) as string[]).sort();
    return (async function* () {
      yield initMsg;
      await probe?.(a.options);
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
  const handle = createTurnHandler({
    git,
    db: env.db,
    config: env.config,
    approvals: stubGateway({ confirm: async () => ({ approved: false, reason: "no" }) }),
    queryFn: next as never,
    intent: devIntent(env.home),
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change it",
  });
  const [plan, exec] = seen;
  return { env, clone, plan, exec, pluginFiles, wt: getWorktreeByThread(env.db, "th1")! };
}

test("lean (default): no full rules; workspace skills load in plan and exec", async () => {
  const { plan, exec } = await runTask({}, ["deploy"]);
  expect([...exec.skills].sort()).toEqual(withExec("main:deploy"));
  expect([...plan.skills].sort()).toEqual(withSet("main:deploy"));
  expect(exec.settingSources).toEqual([]);
  expect(plan.settingSources).toEqual([]);
  for (const o of [plan, exec]) {
    expect(o.systemPrompt.append).not.toContain("workflow: full");
    expect(o.systemPrompt.append).toContain("At most 3"); // the ask boundary applies to every code task
  }
});

test("no repo CLAUDE.md reaches plan or exec prompts, and the registry has no read hint", async () => {
  const { plan, exec } = await runTask({}, [], (clone) =>
    writeFileSync(join(clone, "CLAUDE.md"), "CLAUDE_BODY_MARK"),
  );
  for (const o of [plan, exec]) {
    expect(o.systemPrompt.append).not.toContain("CLAUDE_BODY_MARK");
    expect(o.systemPrompt.append).not.toContain("CLAUDE.md");
    expect(o.settingSources).toEqual([]);
  }
});

test("repo .claude/skills (clone and worktree) plus hooks never contribute to plan or exec", async () => {
  const { plan, exec, pluginFiles } = await runTask(
    {},
    ["deploy"],
    (clone) => {
      // Untracked decoys in the clone: skills, hooks and an mcp file.
      const d = join(clone, ".claude", "skills", "clone-only");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), "---\nname: clone-only\ndescription: d\n---\nx\n");
      mkdirSync(join(clone, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(clone, ".claude", "hooks", "hooks.json"), '{"hooks":{}}');
    },
    ["tracked"],
  );
  expect([...plan.skills].sort()).toEqual(withSet("main:deploy"));
  expect([...exec.skills].sort()).toEqual(withExec("main:deploy"));
  expect(pluginFiles.some((f) => /clone-only|tracked|hooks/.test(f))).toBe(false);
});

test("full: exec lists the workspace skills through an app-owned plugin copy, not the repo", async () => {
  const { clone, plan, exec, wt, pluginFiles } = await runTask({ workflow: "full" }, [
    "deploy",
    "review",
  ]);
  const pdir: string = exec.plugins.at(-1).path; // set plugin first, workspace plugin last
  expect(exec.plugins).toHaveLength(2);
  expect(exec.skills.sort()).toEqual(withExec("main:deploy", "main:review")); // workspace name = plugin name
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

test("full without workspace skills: only the role's set plugin", async () => {
  const { exec } = await runTask({ workflow: "full" }, [], undefined, ["tracked"]);
  expect(exec.plugins).toHaveLength(1);
  expect([...exec.skills].sort()).toEqual(withExec());
  expect(exec.settingSources).toEqual([]);
});

test("full: the clone is readable in the exec guard but never writable", async () => {
  const { clone, exec } = await runTask({ workflow: "full" }, ["deploy"]);
  const skillFile = join(realpathSync(clone), "a.txt");
  const lean = await runTask({}, ["deploy"]);
  const read = (o: any, p: string) => o.canUseTool("Read", { file_path: p }, {});
  expect((await read(exec, skillFile)).behavior).toBe("allow");
  expect((await read(lean.exec, join(realpathSync(lean.clone), "a.txt"))).behavior).not.toBe(
    "allow",
  );
  const write = await exec.canUseTool("Write", { file_path: skillFile, content: "x" }, {});
  expect(write.behavior).toBe("deny");
});

test("skills of the run: the plugin dir is readable and its publisher scripts run without approval, in plan and exec; nothing else opens up", async () => {
  const probed: { stage: string; [k: string]: unknown }[] = [];
  await runTask({}, ["deploy"], undefined, [], async (o) => {
    const [pub, ws] = o.plugins.map((p: { path: string }) => p.path);
    const script = join(pub, "skills", "executing-plans", "scripts", "task-start");
    const decide = async (tool: string, input: object) =>
      (await o.canUseTool(tool, input, {})).behavior;
    probed.push({
      stage: o.permissionMode === "plan" ? "plan" : "exec",
      readSkill: await decide("Read", {
        file_path: join(pub, "skills", "writing-plans", "SKILL.md"),
      }),
      readWorkspace: await decide("Read", { file_path: join(ws, "skills", "deploy", "SKILL.md") }),
      run: await decide("Bash", { command: `${script} ${join(o.cwd, "plan.md")} 1` }),
      runViaBash: await decide("Bash", { command: `bash ${script} ${join(o.cwd, "plan.md")} 1` }),
      chainedHardDeny: await decide("Bash", {
        command: `${script} ${join(o.cwd, "plan.md")} 1 && sudo ls`,
      }),
    });
  });
  expect(probed.map((p) => p.stage)).toEqual(["plan", "exec"]);
  for (const p of probed) {
    expect(p).toMatchObject({
      readSkill: "allow",
      readWorkspace: "allow",
      run: "allow",
      runViaBash: "allow",
      chainedHardDeny: "deny",
    });
  }
});
