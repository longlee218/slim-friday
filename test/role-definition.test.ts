import { expect, test } from "bun:test";
import { SONNET_MODEL } from "../src/config/model-ids";
import { validateRole } from "../src/orchestrator/run/validate-role";
import { getRole, ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { AGENT_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";

test("dev is a background role: one run, bypass from the first token, no plan control", () => {
  expect(getRole("developer").kind).toBe("worker");
  expect(getRole("developer").permissionMode).toBe("bypassPermissions");
  expect(getRole("developer").streaming).toBe(true);
  expect(getRole("developer").limits.maxAsk).toBe(6);
  expect(getRole("developer").budgetUsd).toBe(8);
  expect(getRole("developer").capabilities).toContain("ask");
  expect(getRole("developer").capabilities).not.toContain("planControl" as never);
  expect(getRole("developer").model).toBe(SONNET_MODEL);
  expect(getRole("developer").skills).not.toContain("brainstorming"); // the teammate alone talks to the human
});

test("the teammate is a foreground role without shell, ask, write or subagents; the scout is a read-only background worker", () => {
  expect(getRole("chief-of-staff").kind).toBe("teammate");
  for (const c of ["write", "ask", "shell"])
    expect(getRole("chief-of-staff").capabilities).not.toContain(c as never);
  expect(getRole("chief-of-staff").noSubagents).toBe(true);
  expect(getRole("chief-of-staff").permissionMode).toBe("auto");
  expect(getRole("scout").kind).toBe("worker");
  expect(getRole("scout").sideEffects).toBe("none");
  for (const c of ["write", "ask"]) expect(getRole("scout").capabilities).not.toContain(c as never);
});

test("role data is flat: no stages, gates, handoffs or per-run timeouts in any role", () => {
  for (const r of Object.values(ROLES))
    for (const k of ["stages", "gate", "handoff", "timeoutMs", "output", "countsTowardCap"])
      expect(k in r).toBe(false);
});

test("validateRole refuses a role without a positive budget or with a bad ask limit", () => {
  expect(validateRole(getRole("developer"))).toBeUndefined();
  expect(validateRole(getRole("chief-of-staff"))).toBeUndefined();
  expect(validateRole(getRole("scout"))).toBeUndefined();
  const bad = (p: Partial<RoleDefinition>) => validateRole({ ...getRole("developer"), ...p });
  expect(bad({ budgetUsd: 0 })).toContain("budget");
  expect(bad({ limits: { ...getRole("developer").limits, maxAsk: -1 } })).toContain("ask limit");
  expect(bad({ limits: { ...getRole("developer").limits, maxAsk: 1.5 } })).toContain("ask limit");
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
  expect(getRole("developer").subagents).toEqual({ parallel: 3, depth: 1 });
  expect(ROLES.tester!.subagents).toEqual({ parallel: 2, depth: 1 });
});
