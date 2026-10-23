import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import {
  ARTIFACTS_MCP_SERVER,
  EFFECTS_MCP_SERVER,
  MEMORY_MCP_SERVER,
  ORCHESTRATION_MCP_SERVER,
} from "../src/mcp/mcp-tool-names";
import { MEMORY_SAVE_TOOL } from "../src/mcp/memory/tools/MemorySaveTool/constants";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { setupWorkflow } from "./code-flow-fixture";
import { resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { devTeammateQuery, workersDone } from "./teammate-harness";

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
    teammateTiming: { debounceMs: 10, announceWindowMs: 20 },
    queryFn: devTeammateQuery((a: any) => {
      seen.push(a.options);
      return (async function* () {
        yield resultMsg({ result: "done\n\nlocation: real" });
      })();
    }),
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "change x",
  });
  await workersDone(env.db); // the worker runs detached
  expect(seen).toHaveLength(1); // one run
  return { env, clone: realpathSync(clone), exec: seen[0] };
}

test("the dev run works in the location's own checkout: cwd = location path, scratch dir readable, no clone made", async () => {
  const { env, clone, exec } = await runExec();
  expect(exec.cwd).toBe(clone);
  const taskId = (
    env.db.query("SELECT id FROM turns WHERE role = 'developer'").get() as { id: string }
  ).id;
  expect(exec.additionalDirectories).toEqual([realpathSync(workspacePaths(env.home).run(taskId))]);
  // No plan file: the location is on the turn row, named by the run's final `location:` line.
  expect(env.db.query("SELECT location FROM turns WHERE role = 'developer'").get()).toEqual({
    location: "real",
  });
});

test("dev: only the app's MCP servers; a worker's env keeps no owner secret (the SDK also scrubs its tools' env)", async () => {
  const { exec } = await runExec();
  // Only the app's in-process servers (memory, Report result, effect tools).
  expect(Object.keys(exec.mcpServers)).toEqual([
    MEMORY_MCP_SERVER,
    ARTIFACTS_MCP_SERVER,
    ORCHESTRATION_MCP_SERVER,
    EFFECTS_MCP_SERVER,
  ]);
  // A worker runs repo code: no gh / git login of the owner in its env. The effect tools use it in their own subprocess.
  expect(exec.env.GH_TOKEN).toBeUndefined();
  expect(exec.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
});

test("dev guard: writes in the location (.github and the git dir too), scratch and the SDK plans dir; nothing else", async () => {
  const { env, clone, exec } = await runExec();
  const ws = workspacePaths(env.home).workspace("main");
  const write = async (file_path: string) =>
    (await exec.canUseTool("Write", { file_path, content: "x" }, {})).behavior;
  mkdirSync(join(ws.root, "worktrees"), { recursive: true });
  expect(await write(join(clone, "src", "a.ts"))).toBe("allow");
  expect(await write(join(clone, ".github", "workflows", "ci.yml"))).toBe("allow");
  // The location is trusted: its git dir is writable like the rest of it (hooks, config, info).
  expect(await write(join(clone, ".git", "info", "exclude"))).toBe("allow");
  expect(await write(join(clone, ".git", "hooks", "pre-commit"))).toBe("allow");
  // No worktrees dir: a write under the workspace's old worktrees dir is outside every grant.
  expect(await write(join(realpathSync(ws.root), "worktrees", "real", "a.ts"))).toBe("deny");
  expect(await write(join(env.home, "outside.txt"))).toBe("deny");
  // Runs work in the location's checkout: EnterWorktree is denied whatever the path.
  expect((await exec.canUseTool("EnterWorktree", { path: clone }, {})).behavior).toBe("deny");
  expect(await write("/etc/friday-x")).toBe("deny");
});

test("dev guard: Bash passes the guard (not parsed); the OS sandbox bounds it", async () => {
  const { exec } = await runExec();
  const bash = async (command: string) => (await exec.canUseTool("Bash", { command }, {})).behavior;
  expect(await bash("git status")).toBe("allow");
  expect(await bash("git push -u origin friday/x")).toBe("allow"); // fails at the network, not here
  expect(await bash("")).toBe("deny"); // an empty command is never a call
});

test("dev prompt: no worktree line; delivery waits for the owner's choice", async () => {
  const { exec } = await runExec();
  expect(exec.systemPrompt.append).not.toContain("git worktree");
  expect(exec.systemPrompt.append).toContain("merge, push or PR only after the owner chose it");
});

test("wiring: the developer run's real memory server is read-only (owner rule: only the teammate saves)", async () => {
  const { exec } = await runExec();
  // Test-only: `_registeredTools` is an undocumented MCP SDK internal (no public list call on the instance).
  const held = Object.keys(exec.mcpServers[MEMORY_MCP_SERVER].instance._registeredTools);
  expect(held).not.toContain(MEMORY_SAVE_TOOL);
  expect(held.length).toBeGreaterThan(0);
});
