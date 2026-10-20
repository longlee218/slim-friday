import { expect, test } from "bun:test";
import { SONNET_MODEL } from "../src/config/model-ids";
import { validateRole } from "../src/orchestrator/run/validate-role";
import { DEVELOPER_ROLE } from "../src/roles/builtin/developer-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { SCOUT_ROLE } from "../src/roles/builtin/scout-role";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { AGENT_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";

test("dev is a background role: one run, bypass from the first token, no plan control", () => {
  expect(DEVELOPER_ROLE.kind).toBe("worker");
  expect(DEVELOPER_ROLE.permissionMode).toBe("bypassPermissions");
  expect(DEVELOPER_ROLE.streaming).toBe(true);
  expect(DEVELOPER_ROLE.limits.maxAsk).toBe(6);
  expect(DEVELOPER_ROLE.budgetUsd).toBe(8);
  expect(DEVELOPER_ROLE.capabilities).toContain("ask");
  expect(DEVELOPER_ROLE.capabilities).not.toContain("planControl" as never);
  expect(DEVELOPER_ROLE.model).toBe(SONNET_MODEL);
  expect(DEVELOPER_ROLE.skills).not.toContain("brainstorming"); // the lead alone talks to the human
});

test("the lead is a foreground role without shell, ask, write or subagents; the scout is a read-only background worker", () => {
  expect(LEAD_ROLE.kind).toBe("lead");
  for (const c of ["write", "ask", "shell"])
    expect(LEAD_ROLE.capabilities).not.toContain(c as never);
  expect(LEAD_ROLE.noSubagents).toBe(true);
  expect(LEAD_ROLE.permissionMode).toBe("auto");
  expect(SCOUT_ROLE.kind).toBe("worker");
  expect(SCOUT_ROLE.sideEffects).toBe("none");
  for (const c of ["write", "ask"]) expect(SCOUT_ROLE.capabilities).not.toContain(c as never);
});

test("role data is flat: no stages, gates, handoffs or per-run timeouts in any role", () => {
  for (const r of Object.values(ROLES))
    for (const k of ["stages", "gate", "handoff", "timeoutMs", "output", "countsTowardCap"])
      expect(k in r).toBe(false);
});

test("validateRole refuses a role without a positive budget or with a bad ask limit", () => {
  expect(validateRole(DEVELOPER_ROLE)).toBeUndefined();
  expect(validateRole(LEAD_ROLE)).toBeUndefined();
  expect(validateRole(SCOUT_ROLE)).toBeUndefined();
  const bad = (p: Partial<RoleDefinition>) => validateRole({ ...DEVELOPER_ROLE, ...p });
  expect(bad({ budgetUsd: 0 })).toContain("budget");
  expect(bad({ limits: { ...DEVELOPER_ROLE.limits, maxAsk: -1 } })).toContain("ask limit");
  expect(bad({ limits: { ...DEVELOPER_ROLE.limits, maxAsk: 1.5 } })).toContain("ask limit");
});

const SPAWNERS = new Set(["developer", "tester"]);

test("subagents: only the developer (3 parallel) and the tester (2 parallel) may spawn (depth 1); every role declares the bounds", () => {
  for (const r of Object.values(ROLES)) {
    expect([r.name, r.subagents.depth >= 1, r.subagents.parallel >= 1]).toEqual([
      r.name,
      true,
      true,
    ]);
    expect([r.name, r.limits.maxTurns > 0]).toEqual([r.name, true]);
    expect([r.name, !r.noSubagents, toolsFor(r).includes(AGENT_TOOL_NAME)]).toEqual([
      r.name,
      SPAWNERS.has(r.name),
      SPAWNERS.has(r.name),
    ]);
  }
  expect(DEVELOPER_ROLE.subagents).toEqual({ parallel: 3, depth: 1 });
  expect(ROLES.tester!.subagents).toEqual({ parallel: 2, depth: 1 });
});
