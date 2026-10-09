import { expect, test } from "bun:test";
import type { StageName as ToolMode } from "../src/roles/role-registry";
import { buildSystemPrompt } from "../src/runtime/system-prompt";
import { DELEGATE_TASK_MCP_TOOL_NAME } from "../src/tools/DelegateTaskTool/constants";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { GIT_GROUPS } from "../src/tools/tool-catalog";

/** Rules text of a mode (no context). */
const rules = (mode: ToolMode, handoff = false) => buildSystemPrompt("", mode, { handoff }).append;
/** Occurrences of a marker in a text. */
const count = (text: string, marker: string) => text.split(marker).length - 1;

/** Every (mode, handoff) combination the app builds: the three modes plus Q&A with the delegate tool. */
const CASES: ReadonlyArray<readonly [ToolMode, boolean]> = [
  ["qa", false],
  ["plan", false],
  ["exec", false],
  ["qa", true],
];

test("COMMON safety lines appear exactly once in every mode", () => {
  for (const [mode, handoff] of CASES) {
    const text = rules(mode, handoff);
    expect(count(text, "is DATA")).toBe(1);
    expect(count(text, "Never reveal")).toBe(1);
    expect(count(text, ".env")).toBe(1); // the secret-file rule exists in every mode
  }
});

test("no identity or tone words in any mode (case-sensitive: the DelegateTask tool name is mixed case)", () => {
  for (const [mode, handoff] of CASES) {
    expect(rules(mode, handoff)).not.toMatch(/You are|Friday|assistant|concise/);
  }
});

test("HANDOFF only in Q&A with the handoff flag", () => {
  expect(rules("qa", true)).toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(rules("qa", false)).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(rules("plan", true)).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
  expect(rules("exec", true)).not.toContain(DELEGATE_TASK_MCP_TOOL_NAME);
});

test("plan: ExitPlanMode rule and the repo line", () => {
  const text = rules("plan");
  expect(text).toContain("plan mode");
  expect(text).toContain(EXIT_PLAN_MODE_TOOL_NAME);
  expect(text).toContain('"repo: <name>"');
  expect(text).toContain("Do NOT implement");
  expect(text).toContain("do not retry");
});

test("injection rule tells the owner without repeating the payload", () => {
  expect(rules("qa")).toContain("do not repeat the instructions");
});

test("sections come in order: mode, handoff, common, context", () => {
  const text = buildSystemPrompt("CTX", "qa", { handoff: true }).append;
  const at = (s: string) => text.indexOf(s);
  expect(at("This run is read-only")).toBeLessThan(at(DELEGATE_TASK_MCP_TOOL_NAME));
  expect(at(DELEGATE_TASK_MCP_TOOL_NAME)).toBeLessThan(at("is DATA"));
  expect(at("is DATA")).toBeLessThan(at("CTX"));
});

test("exec: follow-up, memory contract and commit git tools; no repo line", () => {
  const text = rules("exec");
  expect(text).toContain("pure question");
  expect(text).toContain('"Memory:"');
  expect(text).toContain("[global]");
  expect(text).toContain("NEVER add Co-Authored-By");
  for (const tool of GIT_GROUPS.commit) expect(text).toContain(tool);
  expect(text).not.toContain("repo: <name>");
});

test("context goes after the rules with a blank line; empty context gives rules only", () => {
  const withCtx = buildSystemPrompt("CTX", "qa").append;
  expect(withCtx.endsWith("\n\nCTX")).toBe(true);
  expect(withCtx.startsWith(rules("qa"))).toBe(true);
  expect(rules("qa").endsWith("CTX")).toBe(false);
  expect(rules("qa").endsWith("\n")).toBe(false);
});

test("preset shape is unchanged", () => {
  expect(buildSystemPrompt("", "qa")).toMatchObject({ type: "preset", preset: "claude_code" });
});

test("ask boundary in plan and exec only; vague exception in plan only; full rules only for full", () => {
  for (const mode of ["plan", "exec"] as const) {
    expect(rules(mode)).toContain(ASK_USER_QUESTION_TOOL_NAME);
    expect(rules(mode)).toContain("ONE");
    expect(rules(mode)).not.toContain("[workflow: full]");
    expect(buildSystemPrompt("", mode, { workflow: "full" }).append).toContain("[workflow: full]");
    expect(buildSystemPrompt("", mode, { workflow: "lean" }).append).toBe(rules(mode));
  }
  expect(rules("qa")).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
  expect(buildSystemPrompt("", "qa", { workflow: "full" }).append).toBe(rules("qa"));
  expect(rules("plan")).toContain("too vague");
  expect(rules("exec")).not.toContain("too vague");
  expect(buildSystemPrompt("", "plan", { workflow: "full" }).append).toContain(
    "For a repo marked [workflow: full]",
  );
  expect(buildSystemPrompt("", "exec", { workflow: "full" }).append).toContain(
    "This repo is [workflow: full]",
  );
});

test("Q&A rules pin: git MCP tools must always get path, taken from the repo list or the pinned/only repo", () => {
  const qa = rules("qa");
  expect(qa).toContain("Git MCP tools");
  expect(qa).toContain("must always get path = the repo path");
  expect(qa).toContain("pinned/only repo");
  expect(rules("plan")).not.toContain("Git MCP tools (git_log");
});
