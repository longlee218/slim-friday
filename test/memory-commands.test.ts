import { expect, test } from "bun:test";
import { parseMemoryCommand } from "../src/memory/memory-commands";
import { parseTaskCommand } from "../src/tasks/task-commands";

test("remember/nhớ with every scope word; only the first word is a scope", () => {
  const p = (s: string) => parseMemoryCommand(s);
  expect(p("remember: use bun")).toEqual({
    kind: "remember",
    scope: { kind: "default" },
    text: "use bun",
  });
  expect(p("REMEMBER:global use bun")).toMatchObject({
    scope: { kind: "global" },
    text: "use bun",
  });
  expect(p("nhớ: chung dùng bun")).toMatchObject({ scope: { kind: "global" }, text: "dùng bun" });
  expect(p("Nhớ: ws dùng bun")).toMatchObject({ scope: { kind: "workspace" }, text: "dùng bun" });
  expect(p("remember: workspace tests need docker")).toMatchObject({
    scope: { kind: "workspace" },
  });
  expect(p("remember: repo:Api run make")).toMatchObject({
    scope: { kind: "repo", name: "Api" },
    text: "run make",
  });
  // a scope word later in the text is plain text
  expect(p("remember: note chung stuff")).toMatchObject({
    scope: { kind: "default" },
    text: "note chung stuff",
  });
  // decomposed accents (NFD) still parse
  expect(p("nh\u1edb: x y z".normalize("NFD"))).not.toBeNull();
});

test("forget/quên, compact/gom nén, and non-commands", () => {
  expect(parseMemoryCommand("forget: ws old note")).toEqual({
    kind: "forget",
    scope: { kind: "workspace" },
    needle: "old note",
  });
  expect(parseMemoryCommand("quên: chung abc")).toMatchObject({
    kind: "forget",
    scope: { kind: "global" },
  });
  expect(parseMemoryCommand("compact memory")).toEqual({ kind: "compact", dryRun: false });
  expect(parseMemoryCommand("Gom nén dry-run")).toEqual({ kind: "compact", dryRun: true });
  for (const t of [
    "how do I remember things?",
    "remember to run tests",
    "compact memory please",
    "forgetful: x",
  ])
    expect(parseMemoryCommand(t)).toBeNull();
});

test("bad lengths and scope-only commands are invalid (never null, never the agent)", () => {
  expect(parseMemoryCommand("remember: ab")).toMatchObject({ kind: "invalid" });
  // default scope: the max is enforced after the bare-repo-word step (handler), explicit scopes now
  expect(parseMemoryCommand(`remember: ws ${"x".repeat(301)}`)).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand(`remember: ${"x".repeat(300)}`)).toMatchObject({ kind: "remember" });
  expect(parseMemoryCommand("remember: global")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand("forget: ab")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand(`forget: ws ${"x".repeat(101)}`)).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand("remember:")).toMatchObject({ kind: "invalid" });
});

test("parseTaskCommand marks memory commands so the agent never sees them", () => {
  expect(parseTaskCommand("remember: use bun")).toEqual({ kind: "memory" });
  expect(parseTaskCommand("compact memory")).toEqual({ kind: "memory" });
  expect(parseTaskCommand("what is remember: for?")).toMatchObject({ kind: "qa" });
});
