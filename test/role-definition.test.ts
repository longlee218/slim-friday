import { expect, test } from "bun:test";
import { extractRepoMarker } from "../src/orchestrator/engine/run-report";
import { validateRole } from "../src/orchestrator/engine/validate-role";
import { ASSISTANT_ROLE } from "../src/roles/builtin/assistant-role";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import { entryRole, hasClassTiers, ROLES, turnTypeOf } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

const repo = (name: string) => ({
  name,
  workspace: "w",
  dir: `/w/${name}`,
  path: `/r/${name}`,
  description: "",
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
  expect(hasClassTiers(DEV_ROLE)).toBe(true);
});

test("the assistant is a plain foreground role: shell but no ask, no write", () => {
  expect(ASSISTANT_ROLE.background).toBe(false);
  for (const c of ["write", "ask"]) expect(ASSISTANT_ROLE.capabilities).not.toContain(c as never);
  expect(ASSISTANT_ROLE.gitGroups).toEqual(["read"]);
  expect(ASSISTANT_ROLE.permissionMode).toBe("auto");
  expect(turnTypeOf(ASSISTANT_ROLE)).toBe("qa");
  expect(entryRole()).toBe(ASSISTANT_ROLE);
});

test("role data is flat: no stages, gates, handoffs or per-run timeouts in any role", () => {
  for (const r of Object.values(ROLES))
    for (const k of ["stages", "gate", "handoff", "timeoutMs", "output", "countsTowardCap"])
      expect(k in r).toBe(false);
});

test("validateRole refuses a role without a positive budget or with a bad ask limit", () => {
  expect(validateRole(DEV_ROLE)).toBeUndefined();
  expect(validateRole(ASSISTANT_ROLE)).toBeUndefined();
  const bad = (p: Partial<RoleDefinition>) => validateRole({ ...DEV_ROLE, ...p });
  expect(bad({ budgetUsd: 0 })).toContain("budget");
  expect(bad({ limits: { maxAsk: -1 } })).toContain("ask limit");
  expect(bad({ limits: { maxAsk: 1.5 } })).toContain("ask limit");
});

test("extractRepoMarker takes the last `repo:` line, validates it and removes it from the text", () => {
  const repos = [repo("api"), repo("web")];
  expect(extractRepoMarker("done\n\nrepo: web", repos)).toEqual({ text: "done", repo: repos[1] });
  expect(extractRepoMarker("done\n- **repo**: `API`\n", repos).repo).toBe(repos[0]);
  // The last marker wins; an earlier one stays in the text.
  expect(extractRepoMarker("repo: api\nmid\nrepo: web", repos)).toEqual({
    text: "repo: api\nmid",
    repo: repos[1],
  });
});

test("extractRepoMarker: only the last non-empty line counts as the marker", () => {
  const repos = [repo("api")];
  expect(extractRepoMarker("repo: api\nand a closing sentence\n\n", repos)).toEqual({
    text: "repo: api\nand a closing sentence\n\n",
  });
  expect(extractRepoMarker("done\nrepo: api\n\n  \n", repos)).toEqual({
    text: "done",
    repo: repos[0],
  });
});

test("extractRepoMarker: a name outside the workspace or no marker names no repo", () => {
  const repos = [repo("api")];
  expect(extractRepoMarker("done\nrepo: other", repos)).toEqual({ text: "done", repo: undefined });
  expect(extractRepoMarker("done", repos)).toEqual({ text: "done" });
  expect(extractRepoMarker("see repo: api in the text", repos)).toEqual({
    text: "see repo: api in the text",
  });
});
