import { expect, test } from "bun:test";
import { refusalLevel, toolDoneLevel } from "../src/observability/failure-level";

test("a refused lead call warns, an expected refusal and a success stay info", () => {
  expect(refusalLevel(false, "BAD_TASK")).toBe("warn");
  expect(refusalLevel(false, "NO_DEFAULT_PROJECTS_DIR")).toBe("warn");
  for (const c of ["ENDED", "UNCLEAR", "TIMEOUT", "GOAL_NOT_OPEN"])
    expect(refusalLevel(false, c)).toBe("info");
  expect(refusalLevel(true)).toBe("info");
});

test("a failed Friday MCP tool warns; Bash, SDK tools, successes and expected refusals stay info", () => {
  const err = (c: string) => `{"ok":false,"code":"${c}","message":"x"}`;
  expect(toolDoneLevel("mcp__orchestration__Report", true, err("BAD_PARAMS"))).toBe("warn");
  expect(toolDoneLevel("mcp__orchestration__Orchestrate", true, err("ENDED"))).toBe("info");
  expect(toolDoneLevel("mcp__orchestration__Orchestrate", false)).toBe("info");
  expect(toolDoneLevel("Bash", true, "exit 1")).toBe("info");
  expect(toolDoneLevel("Edit", true, "no match")).toBe("info");
});
