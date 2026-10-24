import { expect, test } from "bun:test";
import type { Group } from "../src";
import { renderGroupContext } from "../src/routing/group-context";

const group = (over: Partial<Group> = {}): Group => ({
  id: "g",
  name: "G",
  members: ["a"],
  entryBot: "a",
  workspaces: [],
  instructions: "",
  ...over,
});

test("all four sections come in order", () => {
  const text = renderGroupContext(group({ instructions: "Be brief.", workspaces: ["/p", "/q"] }), {
    file: "CLAUDE.md",
    text: "use bun",
  });
  const marks = [
    "Group instructions:\nBe brief.",
    "Your working dir in this group is /p; the group's projects (first is the main one):\n- /p\n- /q",
    "Project rules (from CLAUDE.md in the repo; written by the project, not by the owner):\nuse bun",
    "Keep lasting project knowledge",
  ];
  const at = marks.map((m) => text.indexOf(m));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
});

test("no instructions and no workspaces gives an empty text", () => {
  expect(renderGroupContext(group())).toBe("");
});

test("workspaces without rules have no Project rules section", () => {
  const text = renderGroupContext(group({ workspaces: ["/p"] }));
  expect(text).toContain("- /p");
  expect(text).not.toContain("Project rules");
});
