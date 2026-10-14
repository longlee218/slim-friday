import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  registryVersion,
  rerouteCandidates,
  validateRegistry,
} from "../src/roles/capability-registry";
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
  gitGroups: [],
  model: "haiku",
  budgetUsd: 0.5,
  promptSections: () => [],
  ...over,
});

const write: Capability[] = ["read", "write"];
const SEVEN = [
  ROLES.assistant as RoleDefinition,
  ROLES.dev as RoleDefinition,
  role("r1", { capabilities: write, approvalRequired: true, sideEffects: "location" }),
  role("r2", { capabilities: write }),
  role("r3"),
  role("r4", { whenToUse: "" }),
  role("r5", { approvalRequired: true }),
];
const none = { visited: [], hasApprovals: true };

test("real roles carry registry data", () => {
  expect(ROLES.assistant?.sideEffects).toBe("none");
  expect(ROLES.dev?.sideEffects).toBe("location");
  expect(ROLES.dev?.approvalRequired).toBe(true);
  expect(() => validateRegistry()).not.toThrow();
  expect(registryVersion()).toBe("assistant@2,dev@2");
});

test("filters: not dispatchable, visited, unauthorized, capability", () => {
  expect(rerouteCandidates(none, SEVEN)).toEqual(["assistant", "dev", "r1", "r2", "r3", "r5"]);
  expect(rerouteCandidates({ ...none, visited: ["dev", "r3"] }, SEVEN)).toEqual([
    "assistant",
    "r1",
    "r2",
    "r5",
  ]);
  expect(rerouteCandidates({ ...none, hasApprovals: false }, SEVEN)).toEqual([
    "assistant",
    "r2",
    "r3",
  ]);
  expect(rerouteCandidates({ ...none, requires: ["write"] }, SEVEN)).toEqual(["dev", "r1", "r2"]);
});

test("default roles = real registry: dev is reachable only with approvals", () => {
  expect(rerouteCandidates({ visited: [], hasApprovals: false })).toEqual(["assistant"]);
  expect(rerouteCandidates({ visited: [], hasApprovals: true })).toEqual(["assistant", "dev"]);
  expect(rerouteCandidates({ visited: [], hasApprovals: true, requires: ["write"] })).toEqual([
    "dev",
  ]);
});

test("ranking orders by probability desc, ignores unknown names, keeps registry order on ties", () => {
  const ranking = { r3: 0.5, r2: 0.3, unclear: 0.9, ghost: 0.8 };
  expect(rerouteCandidates({ ...none, ranking }, SEVEN)).toEqual([
    "r3",
    "r2",
    "assistant",
    "dev",
    "r1",
    "r5",
  ]);
});

test("empty result when every role is visited or filtered", () => {
  const names = SEVEN.map((r) => r.name);
  expect(rerouteCandidates({ ...none, visited: names }, SEVEN)).toEqual([]);
  expect(rerouteCandidates({ ...none, requires: ["shell"] }, [role("r3"), role("r2")])).toEqual([]);
});

test("validateRegistry rejects key mismatch, missing sideEffects, background without approvals", () => {
  expect(() => validateRegistry({ x: role("a") })).toThrow(/Registry key/);
  expect(() =>
    validateRegistry({ a: role("a", { sideEffects: undefined as unknown as "none" }) }),
  ).toThrow(/sideEffects/);
  expect(() => validateRegistry({ a: role("a", { background: true }) })).toThrow(
    /approvalRequired/,
  );
  expect(() => validateRegistry({ a: role("a", { whenToUse: "" }) })).not.toThrow();
});

test("capability-registry.ts names no role", () => {
  const src = readFileSync("src/roles/capability-registry.ts", "utf8");
  const quoted = Object.keys(ROLES)
    .map((n) => `["'\`]${n}["'\`]`)
    .join("|");
  expect(src).not.toMatch(new RegExp(quoted));
});
