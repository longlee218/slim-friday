import { expect, test } from "bun:test";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { mcpServersFor } from "../src/mcp/mcp-servers";
import { GIT_MCP_SERVER, GITHUB_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import {
  dispatchableRoleNames,
  findStage,
  getRole,
  getStage,
  hasClassTiers,
  intentRoles,
  ROLES,
  stageOf,
} from "../src/roles/role-registry";
import type { StageDefinition } from "../src/roles/role-types";
import { AGENT_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";

/** A stage with no `subagents`: the default that must fail closed. */
const BARE: StageDefinition = {
  name: "bare",
  capabilities: ["read", "subagents"],
  gitGroups: [],
  model: "haiku",
  budgetUsd: 0.5,
  promptSections: () => [],
};

test("registry: assistant and dev, unknown role fails", () => {
  expect(Object.keys(ROLES).sort()).toEqual(["assistant", "dev"]);
  expect(() => getRole("nope")).toThrow("Unknown role");
  expect(() => stageOf("nope" as never)).toThrow("Unknown stage");
  expect(getRole("dev").stages.map((s) => s.name)).toEqual(["plan", "exec"]);
  expect(getRole("assistant").stages.map((s) => s.name)).toEqual(["qa"]);
});

test("stages: plan-mode only in plan, worktree only in exec, default tier and budget per stage", () => {
  expect(getStage("dev", "plan").permissionMode).toBe("plan");
  expect(getStage("dev", "exec").permissionMode).toBeUndefined();
  expect(getStage("dev", "exec").isolation).toBe("clone");
  expect(getStage("assistant", "qa")).toMatchObject({
    model: "haiku",
    budgetUsd: 0.5,
    escalatedBudgetUsd: 1.5,
  });
  expect(getStage("dev", "plan")).toMatchObject({ model: "sonnet", budgetUsd: 1.5 });
  expect(getStage("dev", "exec")).toMatchObject({ model: "sonnet", budgetUsd: 3 });
});

test("whenToUse: every role has one, all different; class tiers only for dev", () => {
  const roles = intentRoles();
  expect(roles.map((r) => r.name).sort()).toEqual(["assistant", "dev"]);
  for (const r of roles) expect(r.whenToUse.length).toBeGreaterThan(20);
  expect(new Set(roles.map((r) => r.whenToUse)).size).toBe(roles.length);
  expect(hasClassTiers(getRole("dev"))).toBe(true);
  expect(hasClassTiers(getRole("assistant"))).toBe(false);
});

test("dispatchableRoleNames: roles with whenToUse except the assistant", () => {
  expect(dispatchableRoleNames()).toEqual(["dev"]);
});

test("guard: subagent allowlist comes from the stage; a stage without subagents allows none", () => {
  const scope = { readPaths: ["/r"] };
  const qa = guardFor("qa", scope);
  expect(qa.allowedSubagents).toEqual(["repo-searcher"]);
  expect(checkToolCall(AGENT_TOOL_NAME, { subagent_type: "repo-searcher" }, qa).decision).toBe(
    "allow",
  );
  const bare = guardFor(BARE, scope);
  expect(bare.allowedSubagents).toEqual([]);
  expect(checkToolCall(AGENT_TOOL_NAME, { subagent_type: "repo-searcher" }, bare).decision).toBe(
    "deny",
  );
});

test("mcp servers follow capabilities: git by groups, github by write", async () => {
  expect(Object.keys(await mcpServersFor(getStage("assistant", "qa"), {}))).toEqual([
    GIT_MCP_SERVER,
  ]);
  // A stage without git groups gets no server, and no github (no write).
  expect(await mcpServersFor(BARE, {})).toEqual({});
  // Code stages: github is added when a token is available.
  const exec = Object.keys(await mcpServersFor("exec", {}));
  expect(exec).toContain(GIT_MCP_SERVER);
  expect(exec.filter((k) => k !== GIT_MCP_SERVER && k !== GITHUB_MCP_SERVER)).toEqual([]);
});

test("tools derive from capabilities", () => {
  expect(toolsFor(BARE)).toEqual(["Read", "Glob", "Grep", AGENT_TOOL_NAME]);
});

test("findStage: a stage name in two roles is ambiguous and throws", () => {
  const dup = { ...getRole("dev"), name: "dev2" };
  expect(() => findStage([getRole("dev"), dup], "plan")).toThrow("Ambiguous stage");
  expect(findStage([getRole("dev"), getRole("assistant")], "qa").name).toBe("qa");
});

test("role tags: dev = [dev], assistant = [ask], unique across roles", () => {
  expect(ROLES.dev?.tag).toBe("[dev]");
  expect(ROLES.assistant?.tag).toBe("[ask]");
  const tags = Object.values(ROLES).flatMap((r) => (r.tag ? [r.tag.toLowerCase()] : []));
  expect(new Set(tags).size).toBe(tags.length);
  expect("aliases" in (ROLES.dev ?? {})).toBe(false); // natural-language aliases are gone
});
