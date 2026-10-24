import { expect, test } from "bun:test";
import type { Bot } from "@friday/core";
import { withRoster } from "../src/roster";

const bot = (id: string, name: string, title = ""): Bot =>
  ({
    id,
    name,
    title,
    instructions: "Be brief.",
    model: "m",
    tools: [],
    skills: [],
    subagents: [],
    workspaces: [],
  }) as Bot;

test("a bot in a group gets the roster of that group appended to its instructions", () => {
  const writer = bot("writer", "Writer");
  const out = withRoster(writer, [
    { name: "Video team", members: [writer, bot("editor", "Editor", "edits")] },
  ]);
  expect(out.instructions.startsWith("Be brief.")).toBe(true);
  expect(out.instructions).toContain('"Video team"');
  expect(out.instructions).toContain("- Editor (id: editor) — edits");
  expect(out.instructions).toContain("One bot owns each step");
});

test("a bot in no group is returned unchanged", () => {
  const solo = bot("solo", "Solo");
  expect(withRoster(solo, [])).toBe(solo);
});

test("a bot in two groups gets both rosters", () => {
  const a = bot("a", "A");
  const out = withRoster(a, [
    { name: "G1", members: [a, bot("b", "B")] },
    { name: "G2", members: [a, bot("c", "C")] },
  ]);
  expect(out.instructions).toContain('"G1"');
  expect(out.instructions).toContain('"G2"');
});
