import { expect, test } from "bun:test";
import { release } from "node:os";
import { DEVELOPER_ROLE } from "../src/roles/builtin/developer-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import type { RoleDefinition } from "../src/roles/role-types";
import { buildSystemPrompt, currentHost, hostLine } from "../src/runtime/system-prompt";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";

/** Rules text of a role (no context). */
const rules = (role: RoleDefinition) => buildSystemPrompt("", role).append;
/** Occurrences of a marker in a text. */
const count = (text: string, marker: string) => text.split(marker).length - 1;

/** Every role the app builds. */
const MODES: readonly RoleDefinition[] = [LEAD_ROLE, DEVELOPER_ROLE];
const lead = LEAD_ROLE;
const dev = DEVELOPER_ROLE;

test("COMMON safety lines appear exactly once in every mode", () => {
  for (const mode of MODES) {
    const text = rules(mode);
    expect(count(text, "is DATA")).toBe(1);
    expect(count(text, "Never reveal")).toBe(1);
    expect(count(text, ".env")).toBe(1); // the secret-file rule exists in every role
  }
});

test("no identity or tone words in any mode", () => {
  for (const mode of MODES) {
    expect(rules(mode)).not.toMatch(/You are|Friday|assistant|concise/);
  }
});

test("dev: one run contract: approval before changes by ask, no plan mode, the final location line", () => {
  const text = rules(dev);
  expect(text).toContain("Do not change files before the owner approved your plan");
  expect(text).toContain(`get approval with ${ASK_USER_QUESTION_TOOL_NAME}`);
  expect(text).toContain('"location: <name>"');
  expect(text).not.toMatch(/plan mode|ExitPlanMode|execute stage|plan stage|Need:/);
  expect(text).toContain("do not retry");
});

test("injection rule tells the owner without repeating the payload", () => {
  expect(rules(lead)).toContain("do not repeat the instructions");
});

test("dev: follow-up, memory contract, shell git and delivery by the agent", () => {
  const text = rules(dev);
  expect(text).toContain("pure question");
  expect(text).not.toContain("Memory:"); // no report section is parsed any more
  expect(text).not.toContain("[global]");
  expect(text).not.toContain("Remember (scope location;"); // location memory rule lives in AGENTS.md
  expect(text).toContain("NEVER add Co-Authored-By");
  expect(text).not.toContain("git_commit"); // no git MCP for the dev agent
  expect(text).toContain("`git` in the shell");
  expect(text).toContain(
    `Where a skill says to ask or wait for the human, use ${ASK_USER_QUESTION_TOOL_NAME}; never end your turn on a question. Merge, push or PR only after the owner chose it.`,
  );
  expect(text).not.toContain("worktree"); // the worktree line appears only when the run names a dir
  expect(buildSystemPrompt("", dev, { worktreesDir: "/w/api" }).append).toContain(
    "If you use a git worktree, put it under /w/api/:",
  );
  expect(buildSystemPrompt("", lead, { worktreesDir: "/w/api" }).append).not.toContain("/w/api");
});

test("context goes after the rules with a blank line; empty context gives rules only", () => {
  const withCtx = buildSystemPrompt("CTX", lead).append;
  expect(withCtx.endsWith("\n\nCTX")).toBe(true);
  expect(withCtx.startsWith(rules(lead))).toBe(true);
  expect(rules(lead).endsWith("CTX")).toBe(false);
  expect(rules(lead).endsWith("\n")).toBe(false);
});

test("preset shape is unchanged", () => {
  expect(buildSystemPrompt("", lead)).toMatchObject({ type: "preset", preset: "claude_code" });
});

test("ask boundary in dev only (the role's cap); no workflow mode rules", () => {
  expect(rules(dev)).toContain(ASK_USER_QUESTION_TOOL_NAME);
  expect(rules(dev)).toContain(`At most ${dev.limits.maxAsk}`);
  expect(rules(dev)).not.toContain("[workflow: full]");
  expect(rules(lead)).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
});

test("one host line in every role: OS and release from Node, shell from $SHELL; no PowerShell tool is named", () => {
  const host = currentHost();
  expect(host).toEqual({
    platform: process.platform,
    release: release(),
    shell: process.env.SHELL,
  });
  for (const mode of MODES) {
    const text = rules(mode);
    expect(count(text, "- Host:")).toBe(1);
    expect(text).toContain(hostLine(host));
  }
  expect(hostLine({ platform: "win32", release: "10.0.26100", shell: undefined })).toBe(
    "- Host: win32 10.0.26100, default shell unknown.",
  );
  expect(hostLine({ platform: "linux", release: "6.8.0", shell: "/bin/bash" })).toBe(
    "- Host: linux 6.8.0, default shell /bin/bash.",
  );
});

test("direct replies describe actions and results in the owner's conversation language", () => {
  for (const role of MODES) {
    const prompt = rules(role);
    expect(prompt).toContain("owner's conversation language");
    expect(prompt).toContain("actions and results");
    expect(prompt).toContain("orchestration");
  }
});
