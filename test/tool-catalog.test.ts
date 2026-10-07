import { expect, test } from "bun:test";
import { guardFor } from "../src/guardrails/check-tool-call";
import {
  autoAllowedTools,
  DELEGATE,
  GIT_GROUPS,
  GIT_READ_BY_MODE,
  gitToolsFor,
  hiddenGitTools,
  SECRET_FILE_RULES,
  SUBAGENT_NAMES,
  type ToolMode,
  toolOptions,
  toolsFor,
} from "../src/tools/tool-catalog";

const MODES: ToolMode[] = ["qa", "plan", "exec"];

test("Q&A: read + web + skills + subagents; nothing that writes or runs commands", () => {
  const t = toolsFor("qa");
  for (const x of ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill", "Agent"])
    expect(t).toContain(x);
  for (const x of ["Write", "Edit", "Bash", "AskUserQuestion", "ExitPlanMode"])
    expect(t).not.toContain(x);
});

test("code tasks: plan and exec share one full toolset", () => {
  expect(toolsFor("plan")).toEqual(toolsFor("exec"));
  for (const x of [
    ...["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Skill", "Agent", "AskUserQuestion"],
    ...[
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "ExitPlanMode",
      "EnterPlanMode",
      "ToolSearch",
    ],
  ]) {
    expect(toolsFor("exec")).toContain(x);
  }
  expect(toolsFor("exec")).not.toContain("WebFetch"); // web stays Q&A-only
});

test("no tool is listed twice", () => {
  for (const m of MODES) expect(new Set(toolsFor(m)).size).toBe(toolsFor(m).length);
});

test("auto-allowed tools are a subset of the mode's tools and never include writes, shell or questions", () => {
  for (const m of MODES) {
    // `delegate` is an MCP tool (not in the built-in `tools` list) allowed in qa only.
    for (const t of autoAllowedTools(m).filter((x) => x !== DELEGATE))
      expect(toolsFor(m)).toContain(t);
    for (const t of ["Write", "Edit", "Bash", "AskUserQuestion", "ExitPlanMode", "Agent", "Read"]) {
      expect(autoAllowedTools(m)).not.toContain(t);
    }
  }
  expect(autoAllowedTools("qa")).toEqual(["WebSearch", "WebFetch", "Skill", DELEGATE]);
  expect(autoAllowedTools("plan")).not.toContain(DELEGATE);
  expect(autoAllowedTools("exec")).not.toContain(DELEGATE);
  expect(autoAllowedTools("exec")).toContain("EnterPlanMode");
});

test("git tools: reads everywhere, commit/change only in exec, hidden = the complement", () => {
  expect(gitToolsFor("qa")).toEqual(gitToolsFor("plan"));
  for (const t of [...GIT_GROUPS.read, ...Object.keys(GIT_READ_BY_MODE)])
    expect(gitToolsFor("qa")).toContain(t);
  for (const t of [...GIT_GROUPS.commit, ...GIT_GROUPS.change]) {
    expect(gitToolsFor("qa")).not.toContain(t);
    expect(gitToolsFor("exec")).toContain(t);
  }
  for (const m of MODES) {
    const hidden = hiddenGitTools(m);
    for (const t of gitToolsFor(m)) expect(hidden).not.toContain(`mcp__git__${t}`);
    for (const t of [
      "git_push",
      "git_pull",
      "git_fetch",
      "git_worktree",
      "git_clone",
      "git_clean",
      "git_merge",
      "git_rebase",
    ]) {
      expect(hidden).toContain(`mcp__git__${t}`); // the app's tools: never offered to agents
    }
  }
  expect(hiddenGitTools("qa")).toContain("mcp__git__git_commit");
  expect(hiddenGitTools("exec")).not.toContain("mcp__git__git_commit");
});

test("guardFor: one builder per mode, auto-allowed tools and subagents from the catalog", () => {
  const qa = guardFor("qa", { readPaths: ["/r"], gitReadRepos: ["/r"] });
  expect(qa.allowTools).toEqual(autoAllowedTools("qa"));
  expect(qa.allowedSubagents).toEqual(SUBAGENT_NAMES);
  expect(qa.writePaths).toBeUndefined(); // Q&A writes nothing
  expect(qa.gitWriteRepo).toBeUndefined();
  const exec = guardFor("exec", {
    writePaths: ["/wt"],
    readPaths: ["/wt"],
    gitWriteRepo: "/wt",
    allowedCommands: ["bun test"],
  });
  expect(exec).toMatchObject({
    writePaths: ["/wt"],
    gitWriteRepo: "/wt",
    allowedCommands: ["bun test"],
  });
  expect(exec.allowTools).toEqual(autoAllowedTools("exec"));
});

test("options: tools from the catalog, no allowedTools, strict MCP", () => {
  const o = toolOptions("qa") as Record<string, unknown>;
  expect(o.tools).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill", "Agent"]);
  expect("allowedTools" in o).toBe(false); // would bypass canUseTool
  expect(o.strictMcpConfig).toBe(true);
});

test("disallowedTools only carries what `tools` cannot express: secret-file rules and other modes' git tools", () => {
  for (const mode of ["qa", "plan", "exec"] as const) {
    for (const d of toolOptions(mode).disallowedTools) {
      expect(SECRET_FILE_RULES.includes(d) || d.startsWith("mcp__git__")).toBe(true);
    }
  }
});

test("secret-file deny rules are part of disallowedTools", () => {
  const d = toolOptions("qa").disallowedTools;
  for (const r of [
    "Read(**/.env*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(**/id_rsa*)",
    "Read(**/credentials*)",
  ]) {
    expect(SECRET_FILE_RULES).toContain(r);
    expect(d).toContain(r);
  }
});
