import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudePlansDir, workspacePaths } from "../src/config/workspace-paths";
import { GIT_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { setupWorkflow } from "./code-flow-fixture";
import { devIntent, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

// Exec stage options (Rev 15 phase 3): the stage runs in the approved repo's own checkout (no clone), with the
// guard scope of the spec, no git or GitHub MCP, the owner's env passed through, and the one worktree line.

const FAKE_TOKEN = "fake-owner-token-for-passthrough";
const saved = process.env.GH_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = saved;
});

/** Run a dev task to the end of exec; return the options of the plan and exec runs and the workspace paths. */
async function runExec() {
  process.env.GH_TOKEN = FAKE_TOKEN;
  const { env, clone } = await setupWorkflow();
  const seen: any[] = [];
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: ((a: any) => {
      seen.push(a.options);
      return (async function* () {
        if (a.options.permissionMode === "plan") {
          const p = await a.options.canUseTool(
            EXIT_PLAN_MODE_TOOL_NAME,
            { plan: "repo: real\nchange x" },
            {},
          );
          if (p.behavior === "allow") throw new Error("process aborted");
          return;
        }
        yield resultMsg({ result: "done" });
      })();
    }) as never,
    intent: devIntent(env.home),
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change x",
  });
  const [plan, exec] = seen;
  return { env, clone: realpathSync(clone), plan, exec };
}

test("exec runs in the repo's own checkout: cwd = repo path, scratch + worktrees dir readable, no clone made", async () => {
  const { env, clone, exec } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  expect(exec.cwd).toBe(clone);
  const taskId = (env.db.query("SELECT id FROM turns").get() as { id: string }).id;
  expect(exec.additionalDirectories).toEqual([
    realpathSync(ws.task(taskId).root),
    realpathSync(ws.worktrees),
  ]);
  expect(env.db.query("SELECT COUNT(*) AS n FROM worktrees").get()).toEqual({ n: 0 });
  // The approved plan is saved in the task scratch dir and the repo is on the turn row (what `/go` reads back).
  expect(Bun.file(ws.task(taskId).plan).size).toBeGreaterThan(0);
  expect(env.db.query("SELECT repo FROM turns").get()).toEqual({ repo: "real" });
});

test("exec: no git or GitHub MCP server for dev (plan too); the owner's env passes through", async () => {
  const { plan, exec } = await runExec();
  expect(exec.mcpServers).toEqual({});
  expect(plan.mcpServers).toEqual({});
  expect(Object.keys(exec.mcpServers)).not.toContain(GIT_MCP_SERVER);
  expect(exec.env.GH_TOKEN).toBe(FAKE_TOKEN); // `gh` in the agent's shell uses the owner's login
});

test("exec guard: writes in the repo (its git dir and .github too), the worktrees dir, scratch and the SDK plans dir; nothing else", async () => {
  const { env, clone, exec } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  const write = async (file_path: string) =>
    (await exec.canUseTool("Write", { file_path, content: "x" }, {})).behavior;
  mkdirSync(ws.worktrees, { recursive: true });
  expect(await write(join(clone, "src", "a.ts"))).toBe("allow");
  expect(await write(join(clone, ".github", "workflows", "ci.yml"))).toBe("allow");
  expect(await write(join(clone, ".git", "info", "exclude"))).toBe("allow");
  expect(await write(join(realpathSync(ws.worktrees), "real", "wt", "a.ts"))).toBe("allow");
  expect(await write(join(claudePlansDir(), "p.md"))).toBe("allow");
  expect(await write(join(env.home, "outside.txt"))).toBe("deny");
  expect(await write("/etc/friday-x")).toBe("deny");
});

test("exec guard: `git worktree add` only under the worktrees dir; push of a feature branch runs, main and force do not", async () => {
  const { env, exec } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  const bash = async (command: string) => (await exec.canUseTool("Bash", { command }, {})).behavior;
  const wtDir = realpathSync(ws.worktrees);
  expect(await bash(`git worktree add ${wtDir}/real/feat`)).toBe("allow");
  expect(await bash("git worktree add ../feat")).toBe("deny");
  expect(await bash("git push -u origin friday/x")).toBe("allow");
  expect(await bash("gh pr create --fill")).toBe("allow");
  expect(await bash("git push origin main")).toBe("deny");
  expect(await bash("git push --force origin friday/x")).toBe("deny");
});

test("exec prompt: the one worktree line names <workspace worktrees dir>/<repo>/; the plan stage has none", async () => {
  const { env, exec, plan } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  const line = `If you use a git worktree, put it under ${join(realpathSync(ws.worktrees), "real")}/.`;
  expect(exec.systemPrompt.append).toContain(line);
  expect(plan.systemPrompt.append).not.toContain("git worktree");
  expect(exec.systemPrompt.append).toContain("Merge, push or PR only after the owner chose it.");
});
