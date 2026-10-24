import { expect, test } from "bun:test";
import { stepFromToolCall } from "../src";

test("skill, mcp, subagent, command", () => {
  expect(stepFromToolCall("t1", "Skill", { skill: "code-review" }, 5)).toEqual({
    id: "t1",
    kind: "skill",
    label: "Used skill",
    target: "code-review",
    state: "running",
    startedAt: 5,
  });
  expect(stepFromToolCall("t2", "mcp__github__search_issues", {}, 5)).toMatchObject({
    kind: "mcp",
    label: "Called",
    target: "github · search_issues",
  });
  expect(stepFromToolCall("t3", "Agent", { description: "review diff" }, 5)).toMatchObject({
    kind: "subagent",
    target: "review diff",
  });
  expect(stepFromToolCall("t4", "Bash", { command: "git status\nrm x" }, 5)).toMatchObject({
    kind: "command",
    label: "Ran",
    target: "git status",
  });
});

test("Edit and Write count lines; Read does not", () => {
  expect(
    stepFromToolCall(
      "e",
      "Edit",
      { file_path: "/a.ts", old_string: "a\nb", new_string: "a\nb\nc" },
      0,
    ),
  ).toMatchObject({ label: "Edited", added: 3, removed: 2 });
  expect(stepFromToolCall("w", "Write", { file_path: "/b.md", content: "x\ny" }, 0)).toMatchObject({
    label: "Wrote",
    added: 2,
  });
  expect(stepFromToolCall("r", "Read", { file_path: "/a.ts" }, 0)).not.toHaveProperty("added");
  expect(stepFromToolCall("w", "Write", { file_path: "/b.md", content: "" }, 0)).toMatchObject({
    added: 0,
  });
});

test("long targets are cut, unknown tools keep their name, bad input does not throw", () => {
  expect(stepFromToolCall("x", "Bash", { command: "y".repeat(500) }, 0).target?.length).toBe(121);
  expect(stepFromToolCall("u", "TodoWrite", {}, 0)).toMatchObject({
    kind: "tool",
    label: "TodoWrite",
  });
  expect(stepFromToolCall("n", "Read", { file_path: 42 }, 0).target).toBeUndefined();
  expect(stepFromToolCall("g", "Grep", { pattern: "a" }, 0)).toMatchObject({ label: "Searched" });
  expect(stepFromToolCall("s", "WebSearch", { query: "q" }, 0)).toMatchObject({
    label: "Searched the web",
    target: "q",
  });
});

test("null or non-object input is treated as empty", () => {
  expect(stepFromToolCall("n", "Bash", null as never, 0)).toMatchObject({ kind: "command" });
  expect(stepFromToolCall("m", "Edit", "x" as never, 0).target).toBeUndefined();
});
