import { expect, test } from "bun:test";
import { GIT_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { parseAuthor } from "../src/repos/repo-registry";
import { getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv, resultMsg } from "./helpers";

/** Run the execute stage with a fake SDK whose init reports the git MCP server in `status`. */
async function runExec(status: string) {
  const env = makeEnv();
  const queryFn = (a: any) =>
    (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: "s1",
        mcp_servers: [{ name: GIT_MCP_SERVER, status }],
      } as never;
      // A real SDK would keep going; the fake only gets here if the run was not aborted.
      if (!a.options.abortController.signal.aborted) yield resultMsg({ result: "done" });
      else throw new Error("process aborted");
    })();
  return runAgent({
    prompt: "x",
    taskId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
    guard: { writePaths: [] },
    stage: getStage("dev", "exec"),
    code: { threadId: "th", gateway: undefined },
  });
}

test("execute stage: a git MCP server that failed to start aborts the run with a clear error", async () => {
  const res = await runExec("failed");
  expect(res.outcome).toBe("error");
  expect(res.text).toContain("git MCP server failed to start");
});

test("execute stage: a connected git MCP server runs normally", async () => {
  const res = await runExec("connected");
  expect(res.outcome).toBe("success");
});

test("identities the git server would refuse are rejected up front", () => {
  expect(parseAuthor("Example User <user@example.com>")).not.toBeNull();
  expect(parseAuthor("T <t@t.t>")).toBeNull(); // 1-letter name and domain suffix: the server would not start
  expect(parseAuthor("Test User <test@localhost>")).toBeNull();
});
