import { expect, test } from "bun:test";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { mcpServersFor } from "../src/mcp/mcp-servers";
import { GIT_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import {
  dispatchableRoleNames,
  getRole,
  hasClassTiers,
  intentRoles,
  ROLES,
} from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { CAPABILITY_TOOLS, toolsFor } from "../src/tools/tool-catalog";

/** A minimal role with one capability (the data a role file would give). */
const BARE: RoleDefinition = {
  name: "bare",
  whenToUse: "bare",
  background: false,
  limits: { maxAsk: 0 },
  sideEffects: "none",
  approvalRequired: false,
  capabilityVersion: "1",
  capabilities: ["read"],
  gitGroups: [],
  model: "haiku",
  budgetUsd: 0.5,
  promptSections: () => [],
};

test("registry: assistant, dev and the control role, unknown role fails", () => {
  expect(Object.keys(ROLES).sort()).toEqual(["assistant", "dev", "discord-manager"]);
  expect(() => getRole("nope")).toThrow("Unknown role");
});

test("roles: bypass only for dev, auto for the assistant, default tier and budget per role", () => {
  expect(getRole("dev").permissionMode).toBe("bypassPermissions");
  expect(getRole("assistant").permissionMode).toBe("auto");
  expect(getRole("assistant")).toMatchObject({
    model: "haiku",
    budgetUsd: 1,
    escalatedBudgetUsd: 2.5,
    background: false,
  });
  expect(getRole("dev")).toMatchObject({ model: "sonnet", budgetUsd: 4.5, background: true });
});

test("whenToUse: every role has one, all different; both roles have class tiers", () => {
  const roles = intentRoles();
  expect(roles.map((r) => r.name).sort()).toEqual(["assistant", "dev"]);
  for (const r of roles) expect(r.whenToUse.length).toBeGreaterThan(20);
  expect(new Set(roles.map((r) => r.whenToUse)).size).toBe(roles.length);
  expect(hasClassTiers(getRole("dev"))).toBe(true);
  expect(hasClassTiers(getRole("assistant"))).toBe(true); // P11: haiku / haiku / sonnet
});

test("whenToUse stays within the 220-char budget of prompt-standard.md", () => {
  for (const r of intentRoles()) expect(r.whenToUse.length).toBeLessThanOrEqual(220);
});

test("dispatchableRoleNames: every role with whenToUse (a queued follow-up may be any role)", () => {
  expect(dispatchableRoleNames()).toEqual(["assistant", "dev"]);
});

test("guard: every role gets the subagent tools, auto-allowed, even one that lists no capability for them", () => {
  const scope = { readPaths: ["/r"] };
  const qa = guardFor(getRole("assistant"), scope);
  expect(checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, qa).decision).toBe("allow");
  expect(checkToolCall(LEGACY_AGENT_TOOL_NAME, { prompt: "p" }, qa).decision).toBe("allow");
  const bare = guardFor(BARE, scope); // lists only `read`: toolsFor adds the subagent tools
  expect(checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, bare).decision).toBe("allow");
  expect(checkToolCall(LEGACY_AGENT_TOOL_NAME, { prompt: "p" }, bare).decision).toBe("allow");
});

test("mcp servers come from the role's gitGroups data only: the assistant's git reads; dev and a bare role get none", () => {
  expect(Object.keys(mcpServersFor(getRole("assistant")))).toEqual([GIT_MCP_SERVER]);
  expect(mcpServersFor(BARE)).toEqual({});
  expect(mcpServersFor(getRole("dev"))).toEqual({}); // the agent uses git and gh in the shell
});

test("tools derive from capabilities", () => {
  expect(toolsFor(BARE)).toEqual([
    ...CAPABILITY_TOOLS.read,
    AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    LIST_AGENTS_TOOL_NAME,
  ]);
});

test("role tags: dev = [dev], assistant = [ask], unique across roles", () => {
  expect(ROLES.dev?.tag).toBe("[dev]");
  expect(ROLES.assistant?.tag).toBe("[ask]");
  const tags = Object.values(ROLES).flatMap((r) => (r.tag ? [r.tag.toLowerCase()] : []));
  expect(new Set(tags).size).toBe(tags.length);
  expect("aliases" in (ROLES.dev ?? {})).toBe(false); // natural-language aliases are gone
});
