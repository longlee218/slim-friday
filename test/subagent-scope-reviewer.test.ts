import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GIT_TOOL } from "../src/mcp/mcp-tool-names";
import { SUBAGENTS } from "../src/roles/subagents/subagent-registry";
import {
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { CLONE, decide, FIX, git } from "./subagent-scope-helper";

describe("registry data", () => {
  test("implementer and task-reviewer: tools, model, turns, scope, prompt budget", () => {
    const impl = SUBAGENTS.implementer;
    const rev = SUBAGENTS["task-reviewer"];
    expect(impl?.tools).toEqual([
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      EDIT_TOOL_NAME,
      WRITE_TOOL_NAME,
      BASH_TOOL_NAME,
      git(GIT_TOOL.STATUS),
      git(GIT_TOOL.ADD),
      git(GIT_TOOL.COMMIT),
    ]);
    expect(impl?.scope).toEqual({ readOnly: false, canCommit: true });
    expect(impl?.model).toBe("sonnet");
    expect(impl?.maxTurns).toBe(40);
    expect(impl?.resumable).toBe(true);
    expect(rev?.tools).toEqual([
      READ_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      git(GIT_TOOL.LOG),
      git(GIT_TOOL.DIFF),
      git(GIT_TOOL.STATUS),
      git(GIT_TOOL.SHOW),
    ]);
    expect(rev?.scope).toEqual({ readOnly: true, canCommit: false });
    expect(rev?.resumable).toBeUndefined();
    // Prompt standard: description <= 160 chars, prompt <= 600.
    for (const d of Object.values(SUBAGENTS)) {
      expect(d.description.length).toBeLessThanOrEqual(160);
      expect(d.prompt.length).toBeLessThanOrEqual(600);
    }
  });
});

describe("task-reviewer cannot write, run a shell or commit (by agent_type, recorded fixture shape)", () => {
  test("the recorded subagent call shape is what the guard reads", () => {
    expect(typeof FIX.agent_id).toBe("string");
    expect(FIX.hook_event_name).toBe("PreToolUse");
  });
  const denied: [string, Record<string, unknown>][] = [
    [git(GIT_TOOL.ADD), { path: CLONE }],
    [git(GIT_TOOL.COMMIT), { path: CLONE, message: "fix: x" }],
    [git(GIT_TOOL.CHECKOUT), { path: CLONE }],
    [git(GIT_TOOL.RESET), { path: CLONE }],
    [git(GIT_TOOL.PUSH), { path: CLONE }],
    [WRITE_TOOL_NAME, { file_path: join(CLONE, "a.ts"), content: "x" }],
    [EDIT_TOOL_NAME, { file_path: join(CLONE, "a.ts") }],
    [MULTI_EDIT_TOOL_NAME, { file_path: join(CLONE, "a.ts") }],
    [BASH_TOOL_NAME, { command: "ls" }],
    [BASH_TOOL_NAME, { command: "bun test" }],
  ];
  for (const [tool, input] of denied)
    test(`${tool} is denied`, () =>
      expect(decide("task-reviewer", tool, input).decision).toBe("deny"));
  test("explorer is denied the same git writes", () => {
    for (const t of [GIT_TOOL.ADD, GIT_TOOL.COMMIT])
      expect(decide("explorer", git(t), { path: CLONE, message: "x" }).decision).toBe("deny");
  });
  test("reads of the clone and the git read tools run", () => {
    expect(
      decide("task-reviewer", READ_TOOL_NAME, { file_path: join(CLONE, "a.ts") }).decision,
    ).toBe("allow");
    for (const t of [GIT_TOOL.LOG, GIT_TOOL.DIFF, GIT_TOOL.STATUS, GIT_TOOL.SHOW])
      expect(decide("task-reviewer", git(t), { path: CLONE }).decision).toBe("allow");
  });
});
