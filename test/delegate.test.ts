import { expect, test } from "bun:test";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { mcpToolName, TASKS_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { insertTask } from "../src/storage/run-store";
import { createTaskHandler } from "../src/tasks/handle-task";
import { DELEGATE_TASK_MCP_TOOL_NAME } from "../src/tools/DelegateTaskTool/constants";
import {
  addRepo,
  BRIEF,
  clearWorkspaces,
  delegatingQuery,
  makeEnv,
  resultMsg,
  stubGateway,
} from "./helpers";

/** Run one Q&A message whose agent makes the given `DelegateTask` calls; returns what the tool answered + stage runs. */
async function delegateRun(
  calls: Record<string, unknown>[],
  o: { managed?: boolean; approvals?: boolean; fullCap?: boolean } = {},
) {
  const { managed = true, approvals = true, fullCap = false } = o;
  const env = makeEnv();
  if (managed) {
    clearWorkspaces(env.home);
    addRepo(env.home, "repo"); // managed clone: workspaces/repo/repo
  }
  if (fullCap) {
    for (const id of ["a", "b"])
      insertTask(env.db, { id, threadId: id, source: "t", repo: "repo", type: "code" });
  }
  const results: { isError?: boolean; text: string }[] = [];
  const stages: any[] = [];
  const next = (a: any) => {
    stages.push(a.options);
    return (async function* () {
      yield resultMsg({ result: "plan stage" });
    })();
  };
  const seen: any[] = [];
  const query = delegatingQuery(calls, next, results);
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: ((a: any) => (seen.push(a.options), query(a))) as never,
    approvals: approvals ? stubGateway() : undefined,
  });
  const reply = await handle({ source: "t", userId: "u", threadId: "t1", text: "please fix it" });
  return { env, results, stages, seen, reply };
}

test("delegate: valid call ends the Q&A run, then the plan stage starts with the brief", async () => {
  const { results, stages, reply, env } = await delegateRun([{ brief: BRIEF }]);
  expect(results).toHaveLength(1);
  expect(results[0]!.isError).toBeFalsy();
  expect(stages).toHaveLength(1);
  expect(stages[0].permissionMode).toBe("plan");
  expect(reply).toContain("Starting plan:");
  expect(reply).toContain("plan stage");
  const types = env.db.query("SELECT type FROM tasks ORDER BY started_at, type").all();
  expect(types).toHaveLength(2);
});

test("delegate: refused when the code-task cap is full", async () => {
  const { results, stages } = await delegateRun([{ brief: BRIEF }], { fullCap: true });
  expect(results[0]).toMatchObject({ isError: true });
  expect(results[0]!.text).toContain("busy");
  expect(stages).toHaveLength(0);
});

test("delegate: refused without a managed clone", async () => {
  const { results, stages } = await delegateRun([{ brief: BRIEF }], { managed: false });
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toContain("workspace clone");
  expect(stages).toHaveLength(0);
});

test("delegate: unknown repo is refused", async () => {
  const { results, stages } = await delegateRun([{ brief: BRIEF, repo: "nope" }]);
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toContain('Unknown repo "nope"');
  expect(stages).toHaveLength(0);
});

test("delegate: a second call in the same run is refused, one plan stage only", async () => {
  const { results, stages } = await delegateRun([{ brief: BRIEF }, { brief: BRIEF }]);
  expect(results[0]!.isError).toBeFalsy();
  expect(results[1]).toMatchObject({ isError: true });
  expect(results[1]!.text).toContain("Already delegated");
  expect(stages).toHaveLength(1);
});

test("delegate: role other than dev and a too short brief are rejected by the schema", async () => {
  for (const bad of [{ brief: BRIEF, role: "tester" }, { brief: "too short" }]) {
    const { results, stages } = await delegateRun([bad]);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.text).toContain("Input validation error");
    expect(stages).toHaveLength(0);
  }
});

test("delegate: handoff section is in the Q&A prompt when the tool is registered", async () => {
  const { seen } = await delegateRun([]);
  expect(seen[0].mcpServers[TASKS_MCP_SERVER]).toBeDefined();
  expect(seen[0].systemPrompt.append).toContain(DELEGATE_TASK_MCP_TOOL_NAME);
});

test("delegate: tool is not registered without the approval flow", async () => {
  const { seen, results } = await delegateRun([], { approvals: false });
  expect(seen[0].mcpServers[TASKS_MCP_SERVER]).toBeUndefined();
  expect(seen[0].systemPrompt.append).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME); // no handoff section either
  expect(results).toHaveLength(0);
});

test("guard: delegate is allowed in qa only", () => {
  const scope = { readPaths: ["/x"] };
  expect(checkToolCall(DELEGATE_TASK_MCP_TOOL_NAME, {}, guardFor("qa", scope)).decision).toBe(
    "allow",
  );
  expect(checkToolCall(DELEGATE_TASK_MCP_TOOL_NAME, {}, guardFor("plan", scope)).decision).toBe(
    "deny",
  );
  expect(checkToolCall(DELEGATE_TASK_MCP_TOOL_NAME, {}, guardFor("exec", scope)).decision).toBe(
    "deny",
  );
  expect(
    checkToolCall(mcpToolName(TASKS_MCP_SERVER, "Other"), {}, guardFor("qa", scope)).decision,
  ).toBe("deny");
});
