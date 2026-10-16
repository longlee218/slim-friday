import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateRegistry } from "../src/roles/capability-registry";
import { ROLES } from "../src/roles/role-registry";
import type { Capability, RoleDefinition } from "../src/roles/role-types";

/** A data-only role; `over` sets the fields a case cares about. */
const role = (name: string, over: Partial<RoleDefinition> = {}): RoleDefinition => ({
  name,
  whenToUse: `use ${name}`,
  background: false,
  limits: { maxAsk: 0 },
  sideEffects: "none",
  approvalRequired: false,
  capabilityVersion: "1",
  capabilities: ["read"],
  model: "haiku",
  budgetUsd: 0.5,
  promptSections: () => [],
  ...over,
});

const write: Capability[] = ["read", "write"];
const SIX = [
  ROLES.developer as RoleDefinition,
  role("r1", { capabilities: write, approvalRequired: true, sideEffects: "location" }),
  role("r2", { capabilities: write }),
  role("r3"),
  role("r4", { whenToUse: "" }),
  role("r5", { approvalRequired: true }),
];
test("real roles carry registry data", () => {
  expect(ROLES.scout?.sideEffects).toBe("none");
  expect(ROLES.developer?.sideEffects).toBe("location");
  expect(ROLES.developer?.approvalRequired).toBe(true);
  expect(() => validateRegistry()).not.toThrow();
});

test("validateRegistry rejects key mismatch, missing sideEffects, background without approvals", () => {
  expect(() => validateRegistry({ x: role("a") })).toThrow(/Registry key/);
  expect(() =>
    validateRegistry({ a: role("a", { sideEffects: undefined as unknown as "none" }) }),
  ).toThrow(/sideEffects/);
  expect(() =>
    validateRegistry({ a: role("a", { background: true, sideEffects: "location" }) }),
  ).toThrow(/approvalRequired/);
  // a background role that changes nothing (the scout) needs no approvals
  expect(() => validateRegistry({ a: role("a", { background: true }) })).not.toThrow();
  expect(() => validateRegistry({ a: role("a", { whenToUse: "" }) })).not.toThrow();
});

test("capability-registry.ts names no role", () => {
  const src = readFileSync("src/roles/capability-registry.ts", "utf8");
  const quoted = Object.keys(ROLES)
    .map((n) => `["'\`]${n}["'\`]`)
    .join("|");
  expect(src).not.toMatch(new RegExp(quoted));
});
