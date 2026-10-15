import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudePlansDir, workspacePaths } from "../src/config/workspace-paths";
import {
  GIT_MCP_SERVER,
  MEMORY_MCP_SERVER,
  REMEMBER_TOOL,
  WORKER_MCP_SERVER,
} from "../src/mcp/mcp-tool-names";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { setupWorkflow } from "./code-flow-fixture";
import { resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { workersDone } from "./lead-harness";

// Dev run options (Rev 15 phases 3 and 5): the run works in the location's own checkout (no clone), with the guard
// scope of the spec, no git or GitHub MCP, the owner's env passed through, and the one worktree line.

const FAKE_TOKEN = "fake-owner-token-for-passthrough";
const saved = process.env.GH_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = saved;
});

/** Run a dev task to its end; return the options of its (one) run and the workspace paths. */
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
        yield resultMsg({ result: "done\n\nlocation: real" });
      })();
    }) as never,
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change x",
  });
  await workersDone(env.db); // the worker runs detached
  expect(seen).toHaveLength(1); // one run
  return { env, clone: realpathSync(clone), exec: seen[0] };
}

test("the dev run works in the location's own checkout: cwd = location path, scratch + worktrees dir readable, no clone made", async () => {
  const { env, clone, exec } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  expect(exec.cwd).toBe(clone);
  const taskId = (env.db.query("SELECT id FROM turns").get() as { id: string }).id;
  expect(exec.additionalDirectories).toEqual([
    realpathSync(ws.task(taskId).root),
    realpathSync(ws.worktrees),
  ]);
  // No plan file: the location is on the turn row, named by the run's final `location:` line.
  expect(env.db.query("SELECT location FROM turns").get()).toEqual({ location: "real" });
});

test("dev: no git or GitHub MCP server; the owner's env passes through", async () => {
  const { exec } = await runExec();
  // Only the app's in-process servers (worker result tool, memory); no git server (git and gh run in the shell).
  expect(Object.keys(exec.mcpServers)).toEqual([WORKER_MCP_SERVER, MEMORY_MCP_SERVER]);
  expect(Object.keys(exec.mcpServers)).not.toContain(GIT_MCP_SERVER);
  expect(exec.env.GH_TOKEN).toBe(FAKE_TOKEN); // `gh` in the agent's shell uses the owner's login
});

test("dev guard: writes in the location (its git dir and .github too), the worktrees dir, scratch and the SDK plans dir; nothing else", async () => {
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

test("dev guard: `git worktree add` only under the worktrees dir; push of a feature branch runs, main and force do not", async () => {
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

test("dev prompt: the one worktree line names <workspace worktrees dir>/<location>/", async () => {
  const { env, exec } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  const line = `If you use a git worktree, put it under ${join(realpathSync(ws.worktrees), "real")}/.`;
  expect(exec.systemPrompt.append).toContain(line);
  expect(exec.systemPrompt.append).toContain("Merge, push or PR only after the owner chose it.");
});

test("wiring: Remember through the run's real memory server lands in the run's workspace/location", async () => {
  const { env, exec } = await runExec();
  // Test-only: `_registeredTools` is an undocumented MCP SDK internal (no public call API on the instance); may break on SDK upgrades.
  // The registered tool of the in-process server the role runner built (context closure of run-role.ts).
  const tool = exec.mcpServers[MEMORY_MCP_SERVER].instance._registeredTools[REMEMBER_TOOL];
  const ok = await tool.handler(
    { text: "uses bun test", scope: "location", location: "real", kind: "fact" },
    {},
  );
  expect(ok.isError).toBeUndefined();
  expect(ok.content[0].text).toBe("saved to location/real (Facts)");
  const file = workspacePaths(env.home).workspace("main").location("real").memory;
  expect(readFileSync(file, "utf8")).toContain("- uses bun test (");
  // A location outside this workspace's registry is refused (locationNames comes from the registry).
  const bad = await tool.handler({ text: "x note", scope: "location", location: "other" }, {});
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("real");
  const j = await tool.handler({ text: "journal note", scope: "journal" }, {});
  expect(j.isError).toBeUndefined();
  const jf = readdirSync(join(workspacePaths(env.home).workspace("main").root, "memory"))[0]!;
  expect(
    readFileSync(join(workspacePaths(env.home).workspace("main").root, "memory", jf), "utf8"),
  ).toMatch(/## \d\d:\d\d thread /);
});
