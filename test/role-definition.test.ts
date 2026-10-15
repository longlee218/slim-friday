import { expect, test } from "bun:test";
import { extractLocationMarker } from "../src/orchestrator/engine/run-report";
import { validateRole } from "../src/orchestrator/engine/validate-role";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import { SCOUT_ROLE } from "../src/roles/builtin/scout-role";
import { ROLES, turnTypeOf } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

const location = (name: string) => ({
  name,
  workspace: "w",
  path: `/r/${name}`,
  description: "",
  git: true,
});

test("dev is a background role: one run, bypass from the first token, no plan control", () => {
  expect(DEV_ROLE.background).toBe(true);
  expect(DEV_ROLE.permissionMode).toBe("bypassPermissions");
  expect(DEV_ROLE.streaming).toBe(true);
  expect(DEV_ROLE.limits.maxAsk).toBe(6);
  expect(DEV_ROLE.budgetUsd).toBe(4.5);
  expect(DEV_ROLE.capabilities).toContain("ask");
  expect(DEV_ROLE.capabilities).not.toContain("planControl" as never);
  expect(DEV_ROLE.classTiers).toEqual({ mechanical: "sonnet", standard: "sonnet", design: "opus" });
  expect(DEV_ROLE.skills).toBe("all");
  expect(turnTypeOf(DEV_ROLE)).toBe("code");
});

test("the lead is a foreground role without shell, ask, write or subagents; the scout is a read-only background worker", () => {
  expect(LEAD_ROLE.background).toBe(false);
  for (const c of ["write", "ask", "shell"])
    expect(LEAD_ROLE.capabilities).not.toContain(c as never);
  expect(LEAD_ROLE.noSubagents).toBe(true);
  expect(LEAD_ROLE.permissionMode).toBe("auto");
  expect(turnTypeOf(LEAD_ROLE)).toBe("qa");
  expect(SCOUT_ROLE.background).toBe(true);
  expect(SCOUT_ROLE.sideEffects).toBe("none");
  for (const c of ["write", "ask"]) expect(SCOUT_ROLE.capabilities).not.toContain(c as never);
  expect(SCOUT_ROLE.shellMode).toBe("read"); // its shell is the read-only allowlist
});

test("role data is flat: no stages, gates, handoffs or per-run timeouts in any role", () => {
  for (const r of Object.values(ROLES))
    for (const k of ["stages", "gate", "handoff", "timeoutMs", "output", "countsTowardCap"])
      expect(k in r).toBe(false);
});

test("validateRole refuses a role without a positive budget or with a bad ask limit", () => {
  expect(validateRole(DEV_ROLE)).toBeUndefined();
  expect(validateRole(LEAD_ROLE)).toBeUndefined();
  expect(validateRole(SCOUT_ROLE)).toBeUndefined();
  const bad = (p: Partial<RoleDefinition>) => validateRole({ ...DEV_ROLE, ...p });
  expect(bad({ budgetUsd: 0 })).toContain("budget");
  expect(bad({ limits: { maxAsk: -1 } })).toContain("ask limit");
  expect(bad({ limits: { maxAsk: 1.5 } })).toContain("ask limit");
});

test("extractLocationMarker takes the last `location:` line, validates it and removes it from the text", () => {
  const locations = [location("api"), location("web")];
  expect(extractLocationMarker("done\n\nlocation: web", locations)).toEqual({
    text: "done",
    location: locations[1],
  });
  expect(extractLocationMarker("done\n- **location**: `API`\n", locations).location).toBe(
    locations[0],
  );
  // The last marker wins; an earlier one stays in the text.
  expect(extractLocationMarker("location: api\nmid\nlocation: web", locations)).toEqual({
    text: "location: api\nmid",
    location: locations[1],
  });
});

test("extractLocationMarker: only the last non-empty line counts as the marker", () => {
  const locations = [location("api")];
  expect(extractLocationMarker("location: api\nand a closing sentence\n\n", locations)).toEqual({
    text: "location: api\nand a closing sentence\n\n",
  });
  expect(extractLocationMarker("done\nlocation: api\n\n  \n", locations)).toEqual({
    text: "done",
    location: locations[0],
  });
});

test("extractLocationMarker: a name outside the workspace or no marker names no location", () => {
  const locations = [location("api")];
  expect(extractLocationMarker("done\nlocation: other", locations)).toEqual({
    text: "done",
    location: undefined,
  });
  expect(extractLocationMarker("done", locations)).toEqual({ text: "done" });
  expect(extractLocationMarker("see location: api in the text", locations)).toEqual({
    text: "see location: api in the text",
  });
});

test("extractLocationMarker also accepts the old `repo:` marker", () => {
  const locations = [location("api")];
  expect(extractLocationMarker("done\nrepo: api", locations)).toEqual({
    text: "done",
    location: locations[0],
  });
});
