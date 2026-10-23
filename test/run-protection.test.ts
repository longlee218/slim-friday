import { expect, test } from "bun:test";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { defaultEnvelope } from "../src/policy/envelope";
import { getRole } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { runProtection } from "../src/runtime/run-protection";
import { policyOf } from "../src/tools/role-policy";

/* RunProtection is derived from the tool policy: the default teammate stays unprotected, a shell or an R2+ tool protects any
   run, a dispatched worker is always protected. */

const teammate = (over: Partial<RoleDefinition>): RoleDefinition => ({
  ...getRole("chief-of-staff"),
  ...over,
});

test("default chief-of-staff: nothing changes (no sandbox, not forced to default, env passes)", () => {
  const role = getRole("chief-of-staff");
  expect(runProtection(role, policyOf(role))).toEqual({
    sandbox: false,
    scratchDir: undefined,
    permissionDefault: false,
    scrubEnv: false,
  });
});

test("a teammate with a shell is sandboxed, scrubbed and never auto-approved; it needs its own scratch dir", () => {
  const role = teammate({ capabilities: ["read", "shell"] });
  expect(runProtection(role, policyOf(role), { scratchDir: "/run/x" })).toEqual({
    sandbox: true,
    scratchDir: "/run/x",
    permissionDefault: true,
    scrubEnv: true,
  });
  expect(() => runProtection(role, policyOf(role), {})).toThrow("needs its own scratch dir");
});

test("a teammate with an effect tool but no shell is not sandboxed yet never auto-approved", () => {
  const role = teammate({ mcpTools: [GIT_PUSH_TOOL] });
  expect(runProtection(role, policyOf(role))).toMatchObject({
    sandbox: false,
    permissionDefault: true,
    scrubEnv: false,
  });
});

test("a dispatched worker is protected and its scratch dir is the envelope's goal dir", () => {
  const role = getRole("researcher");
  const envelope = defaultEnvelope("g", ["l"], "/goal/dir");
  expect(runProtection(role, policyOf(role), { envelope })).toEqual({
    sandbox: true,
    scratchDir: "/goal/dir",
    permissionDefault: true,
    scrubEnv: true,
  });
});

/* roleScope: what a teammate run reads and where its scratch dir is. */
import { realpathSync } from "node:fs";
import { roleScope } from "../src/orchestrator/run/role-scope";
import { makeEnv } from "./helpers";

const scopeInput = (env: ReturnType<typeof makeEnv>) => ({
  turnId: "tm1",
  threadId: "th",
  text: "x",
  role: getRole("chief-of-staff"),
  workspace: "main",
  locations: [
    { name: "location", workspace: "main", path: env.location, description: "", git: true },
  ],
  ac: new AbortController(),
});

test("a teammate with a shell gets its own run dir: scratchDir, readable, in the guard", () => {
  const env = makeEnv();
  const role = teammate({ capabilities: ["read", "shell"] });
  const s = roleScope(env.config, scopeInput(env), role);
  const run = realpathSync(env.paths.run("tm1"));
  expect(s.guard.scratchDir).toBe(run);
  expect(s.guard.readPaths).toContain(run);
  expect(s.guard.allowInside).toContain(run);
});

test("a writing teammate always has readPaths (writes + own dirs), never an unlimited read", () => {
  const env = makeEnv();
  const role = teammate({ capabilities: ["read", "write"] });
  const s = roleScope(env.config, scopeInput(env), role);
  expect(s.guard.readPaths).toBeDefined();
  for (const w of s.guard.writePaths ?? []) expect(s.guard.readPaths).toContain(w);
  expect(s.guard.scratchDir).toBe(realpathSync(env.paths.run("tm1")));
});

test("the default chief-of-staff gets no scratch dir (its scope is unchanged)", () => {
  const env = makeEnv();
  const s = roleScope(env.config, scopeInput(env), getRole("chief-of-staff"));
  expect(s.guard.scratchDir).toBeUndefined();
});
