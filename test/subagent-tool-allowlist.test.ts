import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { EFFECTS_MCP_SERVER, MEMORY_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { MEMORY_SEARCH_TOOL } from "../src/mcp/memory/tools/MemorySearchTool/constants";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { newSubagentLimit } from "../src/policy/subagent-limit";
import { getRole } from "../src/roles/role-registry";
import { guardHook } from "../src/runtime/guard-hook";
import { buildToolPermissions } from "../src/runtime/tool-permissions";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  READ_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";

/* Subagent tool allowlist: a call with `agent_id` may use only read/write/shell/web/skills tools of the PARENT role's
   capabilities. Hook inputs are built from the real SDK captures (pre-tool-use-subagent-*.json). */

const FIX = join(import.meta.dir, "fixtures", "sdk-hooks");
const fixture = (n: string) => JSON.parse(readFileSync(join(FIX, n), "utf8"));
const subRead = fixture("pre-tool-use-subagent-builtin-read.json");
const subMcp = fixture("pre-tool-use-subagent-mcp-echo.json");
const log = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;

const DIR = "/work/repo";
const dev = guardFor(getRole("developer"), { writePaths: [DIR], readPaths: [DIR], cwd: DIR });
/** The teammate has no shell. */
const mgr = guardFor(getRole("chief-of-staff"), {});
const sub = { subagent: true };

const decide = (tool: string, input: Record<string, unknown>, ctx = dev, subagent = true) =>
  checkToolCall(tool, input, ctx, { subagent }).decision;

test("subagent Read inside the granted dir is allowed (fixture shape)", () => {
  expect(subRead.agent_id).toBeTruthy();
  expect(decide(subRead.tool_name, { file_path: `${DIR}/a.txt` })).toBe("allow");
});

test("subagent Bash: allowed for a role with shell (developer), denied for one without", () => {
  expect(decide(BASH_TOOL_NAME, { command: "ls" })).toBe("allow");
  expect(decide(BASH_TOOL_NAME, { command: "ls" }, mgr)).toBe("deny");
  // A role WITHOUT shell and without noSubagents: its subagents get no Bash either.
  const noShell = guardFor(
    { ...getRole("developer"), capabilities: ["read", "write", "skills"] },
    {},
  );
  expect(noShell.shell).toBe(false);
  expect(decide(BASH_TOOL_NAME, { command: "ls" }, noShell)).toBe("deny");
});

test("subagent: every MCP tool, owner questions, subagent tools and task tools are denied", () => {
  const denied = [
    subMcp.tool_name, // the captured MCP tool: subagents DO inherit MCP tools, the allowlist stops them
    mcpToolName(EFFECTS_MCP_SERVER, GIT_PUSH_TOOL),
    mcpToolName(MEMORY_MCP_SERVER, MEMORY_SEARCH_TOOL),
    "mcp__unknown__Anything",
    ASK_USER_QUESTION_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    TODO_WRITE_TOOL_NAME,
    "SomeUnknownTool",
  ];
  for (const t of denied) {
    const d = checkToolCall(t, {}, dev, sub);
    expect([t, d.decision]).toEqual([t, "deny"]);
    expect(d.reason).toContain("a subagent may use only");
  }
});

test("the same calls from the parent (no agent_id) are decided as before", () => {
  expect(decide(mcpToolName(MEMORY_MCP_SERVER, MEMORY_SEARCH_TOOL), {}, dev, false)).toBe("allow");
  expect(decide(SEND_MESSAGE_TOOL_NAME, {}, dev, false)).toBe("allow");
  expect(decide(TODO_WRITE_TOOL_NAME, {}, dev, false)).toBe("allow");
  expect(decide("SomeUnknownTool", {}, dev, false)).toBe("ask");
  expect(checkToolCall(READ_TOOL_NAME, { file_path: `${DIR}/a` }, dev).decision).toBe("allow");
});

test("second layer: a subagent Write outside writePaths is still denied, inside is allowed", () => {
  expect(decide(WRITE_TOOL_NAME, { file_path: "/etc/x", content: "" })).toBe("deny");
  expect(decide(WRITE_TOOL_NAME, { file_path: `${DIR}/x`, content: "" })).toBe("allow");
});

/** Run the PreToolUse hook with a raw input; returns the permission decision ("allow" when it lets the call pass). */
async function hookDecision(input: Record<string, unknown>): Promise<string> {
  const hook = guardHook(
    { turnId: "t", threadId: "th", guard: dev },
    new Map(),
    log,
    newSubagentLimit(3),
  );
  const out = (await hook({ hook_event_name: "PreToolUse", ...input } as never, "id", {
    signal: new AbortController().signal,
  })) as { hookSpecificOutput?: { permissionDecision?: string } };
  return out.hookSpecificOutput?.permissionDecision ?? "allow";
}

test("hook: a subagent AskUserQuestion is denied BEFORE the owner-question early return; the parent's still passes", async () => {
  const base = { tool_input: { questions: [] }, tool_use_id: "q1" };
  expect(
    await hookDecision({ ...base, tool_name: ASK_USER_QUESTION_TOOL_NAME, agent_id: "a1" }),
  ).toBe("deny");
  expect(await hookDecision({ ...base, tool_name: ASK_USER_QUESTION_TOOL_NAME })).toBe("allow");
});

test("hook: the captured subagent MCP call is denied, the captured subagent Read is allowed", async () => {
  expect(await hookDecision({ ...subMcp, tool_input: subMcp.tool_input })).toBe("deny");
  expect(await hookDecision({ ...subRead, tool_input: { file_path: `${DIR}/secret.txt` } })).toBe(
    "allow",
  );
});

test("permission layer of a developer run (maxSubagents 3): 3 parallel Agent calls pass, the 4th is denied", async () => {
  const perms = buildToolPermissions({
    turnId: "t",
    threadId: "th",
    guard: dev,
    maxSubagents: getRole("developer").subagents.parallel,
  });
  const run = async (id: string) =>
    (await perms.hooks[0]!.hooks[0]!(
      {
        hook_event_name: "PreToolUse",
        tool_name: AGENT_TOOL_NAME,
        tool_input: { prompt: "p" },
        tool_use_id: id,
      } as never,
      id,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
  for (const id of ["a", "b", "c"]) expect((await run(id)).hookSpecificOutput).toBeUndefined();
  expect((await run("d")).hookSpecificOutput?.permissionDecision).toBe("deny");
});
