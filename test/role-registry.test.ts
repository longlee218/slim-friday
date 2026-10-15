import { expect, test } from "bun:test";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { mcpServersFor } from "../src/mcp/mcp-servers";
import { dispatchableWorkers, getRole, ROLES } from "../src/roles/role-registry";
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

test("registry: dev, the control role, the lead, the planner and the scout; unknown role fails", () => {
  expect(Object.keys(ROLES).sort()).toEqual(["dev", "discord-manager", "lead", "planner", "scout"]);
  expect(() => getRole("nope")).toThrow("Unknown role");
});

test("roles: bypass only for dev, auto for the others that set it, default tier and budget per role", () => {
  expect(getRole("dev").permissionMode).toBe("bypassPermissions");
  expect(getRole("lead").permissionMode).toBe("auto");
  expect(getRole("scout").permissionMode).toBe("auto");
  expect(getRole("dev")).toMatchObject({ model: "sonnet", budgetUsd: 4.5, background: true });
  expect(getRole("lead")).toMatchObject({ model: "sonnet", background: false });
});

test("whenToUse: every dispatchable role has one, all different; dev has class tiers", () => {
  const roles = dispatchableWorkers();
  expect(roles.map((r) => r.name).sort()).toEqual(["dev", "scout"]);
  for (const r of roles) expect(r.whenToUse.length).toBeGreaterThan(20);
  expect(new Set(roles.map((r) => r.whenToUse)).size).toBe(roles.length);
});

test("whenToUse stays within the 220-char budget of prompt-standard.md", () => {
  for (const r of dispatchableWorkers()) expect(r.whenToUse.length).toBeLessThanOrEqual(220);
});

test("guard: every role gets the subagent tools, auto-allowed, even one that lists no capability for them", () => {
  const scope = { readPaths: ["/r"] };
  const dev = guardFor(getRole("dev"), scope);
  expect(checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, dev).decision).toBe("allow");
  expect(checkToolCall(LEGACY_AGENT_TOOL_NAME, { prompt: "p" }, dev).decision).toBe("allow");
  const bare = guardFor(BARE, scope); // lists only `read`: toolsFor adds the subagent tools
  expect(checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, bare).decision).toBe("allow");
  expect(checkToolCall(LEGACY_AGENT_TOOL_NAME, { prompt: "p" }, bare).decision).toBe("allow");
});

test("mcp servers come from the role's gitGroups data only: a bare role and dev get none", () => {
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

test("role tags: dev = [dev], unique across roles", () => {
  expect(ROLES.dev?.tag).toBe("[dev]");
  const tags = Object.values(ROLES).flatMap((r) => (r.tag ? [r.tag.toLowerCase()] : []));
  expect(new Set(tags).size).toBe(tags.length);
  expect("aliases" in (ROLES.dev ?? {})).toBe(false); // natural-language aliases are gone
});
