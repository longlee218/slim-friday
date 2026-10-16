import { expect, test } from "bun:test";
import { SONNET_MODEL } from "../src/config/model-ids";
import { validateRole } from "../src/orchestrator/run/validate-role";
import { DEVELOPER_ROLE } from "../src/roles/builtin/developer-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { SCOUT_ROLE } from "../src/roles/builtin/scout-role";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

test("dev is a background role: one run, bypass from the first token, no plan control", () => {
  expect(DEVELOPER_ROLE.kind).toBe("worker");
  expect(DEVELOPER_ROLE.permissionMode).toBe("bypassPermissions");
  expect(DEVELOPER_ROLE.streaming).toBe(true);
  expect(DEVELOPER_ROLE.limits.maxAsk).toBe(6);
  expect(DEVELOPER_ROLE.budgetUsd).toBe(4.5);
  expect(DEVELOPER_ROLE.capabilities).toContain("ask");
  expect(DEVELOPER_ROLE.capabilities).not.toContain("planControl" as never);
  expect(DEVELOPER_ROLE.model).toBe(SONNET_MODEL);
  expect(DEVELOPER_ROLE.skills).toContain("brainstorming");
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
  expect(bad({ limits: { maxAsk: -1 } })).toContain("ask limit");
  expect(bad({ limits: { maxAsk: 1.5 } })).toContain("ask limit");
});
