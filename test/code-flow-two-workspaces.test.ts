import { expect, test } from "bun:test";
/** Same fake SDK as the main code-flow tests, copied small: the worker commits b.txt. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS_MCP_SERVER,
  BROWSER_MCP_SERVER,
  EFFECTS_MCP_SERVER,
  MEMORY_MCP_SERVER,
  ORCHESTRATION_MCP_SERVER,
} from "../src/mcp/mcp-tool-names";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  clearWorkspaces,
  defaultLocationPath,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";
import { devLeadQuery, until, workersDone } from "./lead-harness";

/** Adds a managed clone `real` to workspace `ws` with the given commit author. */
async function addCloneLocation(home: string, ws: string, author: string, channels: string[] = []) {
  const src = await makeLocation("main");
  const clone = defaultLocationPath(home, "real", ws);
  addLocation(
    home,
    "real",
    { description: ws, gitAuthor: author },
    { workspace: ws, path: clone, channels },
  );
  await g(home, "clone", "-q", src.location, clone);
  await g(clone, "config", "user.email", "x@example.com");
  await g(clone, "config", "user.name", "t");
  return clone;
}

/** Fake SDK recording every run; the dev worker commits a file. */
function fakeSdk(seen: any[]) {
  return (a: any) => {
    seen.push(a);
    const o = a.options;
    return (async function* () {
      writeFileSync(join(o.cwd, "b.txt"), "two\n");
      await g(o.cwd, "add", "b.txt");
      await g(o.cwd, "-c", "user.email=x@example.com", "-c", "user.name=t", "commit", "-qm", "b");
      yield resultMsg({ result: "done\n\nlocation: real", session_id: "sess-exec" });
    })();
  };
}

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

/** Env with workspace `w-b` (location `real`) that ran the thread's first task (one dev run in the location). */
async function started() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  await addCloneLocation(env.home, "w-b", "Bee <bee@example.com>", [TEST_CHANNEL]);
  const seen: any[] = [];
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: devLeadQuery(fakeSdk(seen)),
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  await handle(msg("add b"));
  await workersDone(env.db);
  return { env, seen, handle };
}

test("two workspaces with location `real`: every task runs in the channel's workspace location, even after another workspace gains the same location name", async () => {
  const { env, seen, handle } = await started();
  expect(seen[0].options.cwd).toContain("/w-b/"); // the first task: the location of the channel's workspace
  // An alphabetically earlier workspace gains the same location name after the first task.
  await addCloneLocation(env.home, "w-a", "Aye <aye@example.com>");
  const n = seen.length;
  await handle(msg("also c")); // a new task (no follow-up in a finished task)
  // The lead may also run (it reads the first task's result): pick the second worker call.
  const second = () => seen.slice(n).find((c) => c.options.mcpServers?.[EFFECTS_MCP_SERVER]);
  await until(() => second() !== undefined);
  expect(second().options.cwd).toContain("/w-b/");
  expect(Object.keys(second().options.mcpServers).sort()).toEqual([
    ARTIFACTS_MCP_SERVER,
    BROWSER_MCP_SERVER,
    EFFECTS_MCP_SERVER,
    MEMORY_MCP_SERVER,
    ORCHESTRATION_MCP_SERVER,
  ]); // no git tools, no identity from the app; the effect tools next to Report result
});
