import { expect, test } from "bun:test";
import { registryError } from "../src/lifecycle/registry-check";
import { validateRegistry } from "../src/roles/capability-registry";
import { ROLES } from "../src/roles/role-registry";

test("the real registry passes and holds lead, scout, dev and discord-manager", () => {
  expect(() => validateRegistry()).not.toThrow();
  expect(registryError()).toBeUndefined();
  for (const n of ["lead", "scout", "developer", "discord-manager"]) expect(ROLES[n]).toBeDefined();
});

test("a bad role definition makes validateRegistry throw and registryError report it", () => {
  const bad = { ...ROLES.scout!, name: "other" };
  expect(() => validateRegistry({ scout: bad })).toThrow(/Registry key scout/);
  expect(registryError({ scout: bad })).toMatch(/Registry key scout/);
  const noApproval = { ...ROLES.developer!, background: true, approvalRequired: false };
  expect(() => validateRegistry({ developer: noApproval })).toThrow(/approvalRequired/);
});
