import { expect, test } from "bun:test";
import { HAIKU_MODEL, SONNET_MODEL } from "../src/config/model-ids";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { buildServers } from "../src/mcp/mcp-servers";
import { dispatchableWorkers, getRole, ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import {
  AGENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { CAPABILITY_TOOLS, toolsFor } from "../src/tools/tool-catalog";
import { FULL_CTX } from "./mcp-ctx-fixture";

/** A minimal role with one capability (the data a role file would give). */

const BARE: RoleDefinition = {
  name: "bare",
  whenToUse: "bare",
  background: false,
  limits: { maxAsk: 0 },
  sideEffects: "none",
  capabilities: ["read"],
  model: HAIKU_MODEL,
  budgetUsd: 0.5,
  promptSections: () => [],
};

test("registry: developer, the control role, the lead, the planner and the scout; unknown role fails", () => {
  expect(Object.keys(ROLES).sort()).toEqual([
    "developer",
    "discord-manager",
    "lead",
    "planner",
    "scout",
  ]);
  expect(() => getRole("nope")).toThrow("Unknown role");
});

test("roles: bypass only for developer, auto for the others that set it, default tier and budget per role", () => {
  expect(getRole("developer").permissionMode).toBe("bypassPermissions");
  expect(getRole("lead").permissionMode).toBe("auto");
  expect(getRole("scout").permissionMode).toBe("auto");
  expect(getRole("developer")).toMatchObject({
    model: SONNET_MODEL,
    budgetUsd: 4.5,
    background: true,
  });
  expect(getRole("lead")).toMatchObject({ model: SONNET_MODEL, background: false });
});

test("whenToUse: every dispatchable role has one, all different; developer has class tiers", () => {
  const roles = dispatchableWorkers();
  expect(roles.map((r) => r.name).sort()).toEqual(["developer", "scout"]);
  for (const r of roles) expect(r.whenToUse.length).toBeGreaterThan(20);
  expect(new Set(roles.map((r) => r.whenToUse)).size).toBe(roles.length);
});

test("whenToUse stays within the 220-char budget of prompt-standard.md", () => {
  for (const r of dispatchableWorkers()) expect(r.whenToUse.length).toBeLessThanOrEqual(220);
});

test("guard: every role gets the subagent tools, auto-allowed, even one that lists no capability for them", () => {
  const scope = { readPaths: ["/r"] };
  const dev = guardFor(getRole("developer"), scope);
  expect(checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, dev).decision).toBe("allow");
  const bare = guardFor(BARE, scope); // lists only `read`: toolsFor adds the subagent tools
  expect(checkToolCall(AGENT_TOOL_NAME, { prompt: "p" }, bare).decision).toBe("allow");
});

test("mcp servers come from the role's data only: a bare role gets none, dev none without a ctx", () => {
  expect(buildServers(BARE, FULL_CTX)).toEqual({});
  expect(buildServers(getRole("developer"), {})).toEqual({});
});

test("tools derive from capabilities", () => {
  expect(toolsFor(BARE)).toEqual([
    ...CAPABILITY_TOOLS.read,
    AGENT_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    LIST_AGENTS_TOOL_NAME,
  ]);
});

test("no role carries a tag or aliases (the role tag is gone)", () => {
  for (const r of Object.values(ROLES)) {
    expect("tag" in r).toBe(false);
    expect("aliases" in r).toBe(false);
  }
});
