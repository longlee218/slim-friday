import { expect, test } from "bun:test";
/** Same fake SDK as the main code-flow tests, copied small: the run asks to approve its plan, then commits b.txt. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { MEMORY_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  clearWorkspaces,
  devIntent,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/** Adds a managed clone `real` to workspace `ws` with the given commit author. */
async function addCloneRepo(home: string, ws: string, author: string, channels: string[] = []) {
  const src = await makeRepo("main");
  const clone = workspacePaths(home).workspace(ws).repo("real").clone;
  addRepo(
    home,
    "real",
    { description: ws, gitAuthor: author },
    { workspace: ws, path: clone, channels },
  );
  await g(home, "clone", "-q", src.repo, clone);
  await g(clone, "config", "user.email", "x@example.com");
  await g(clone, "config", "user.name", "t");
  return clone;
}

/** Fake SDK recording every run; the dev run asks to approve its plan, then commits a file. */
function fakeSdk(seen: any[]) {
  return (a: any) => {
    seen.push(a);
    const o = a.options;
    return (async function* () {
      await o.canUseTool(
        ASK_USER_QUESTION_TOOL_NAME,
        { questions: [{ question: "Approve the plan?", options: [{ label: "Approve" }] }] },
        {},
      );
      writeFileSync(join(o.cwd, "b.txt"), "two\n");
      await g(o.cwd, "add", "b.txt");
      await g(o.cwd, "-c", "user.email=x@example.com", "-c", "user.name=t", "commit", "-qm", "b");
      yield resultMsg({ result: "done\n\nrepo: real", session_id: "sess-exec" });
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

/** Env with workspace `w-b` (repo `real`) that ran the thread's first task (one dev run in the repo). */
async function started() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  await addCloneRepo(env.home, "w-b", "Bee <bee@example.com>", [TEST_CHANNEL]);
  const seen: any[] = [];
  const gw = stubGateway({
    confirm: async () => ({ approved: false, reason: "no PR" }),
    askChoice: async (a) => a.options[0],
  });
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: gw,
    queryFn: fakeSdk(seen) as never,
    intent: devIntent(env.home),
  });
  await handle(msg("[dev] add b"));
  return { env, seen, handle };
}

test("two workspaces with repo `real`: every task runs in the channel's workspace repo, even after another workspace gains the same repo name", async () => {
  const { env, seen, handle } = await started();
  expect(seen[0].options.cwd).toContain("/w-b/"); // the first task: the repo of the channel's workspace
  // An alphabetically earlier workspace gains the same repo name after the first task.
  await addCloneRepo(env.home, "w-a", "Aye <aye@example.com>");
  const n = seen.length;
  await handle(msg("[dev] also c")); // a new task (no follow-up in a finished task)
  expect(seen.length).toBeGreaterThan(n);
  expect(seen[n].options.cwd).toContain("/w-b/");
  expect(Object.keys(seen[n].options.mcpServers)).toEqual([MEMORY_MCP_SERVER]); // no git MCP, no identity from the app
});
