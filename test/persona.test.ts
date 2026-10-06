import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { buildPersonaContext, ensureHome } from "../src/memory/persona";
import { loadRepoRegistry } from "../src/repos/repo-registry";
import { addWorkspace, clearWorkspaces, makeEnv } from "./helpers";

test("ensureHome creates defaults + per-workspace files once and never overwrites", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const repo = addWorkspace(env.home, "api", { description: "billing api" });
  writeFileSync(join(repo, "CLAUDE.md"), "repo rules");
  const p = workspacePaths(env.home);
  ensureHome(env.home, loadRepoRegistry(env.home));
  const ws = p.workspace("api");
  for (const f of [p.identity, p.soul, ws.identity, ws.memory]) expect(existsSync(f)).toBe(true);
  expect(existsSync(ws.logs)).toBe(true);
  expect(readFileSync(ws.identity, "utf8")).toContain("billing api");
  expect(readFileSync(p.soul, "utf8")).toContain("Vietnamese");
  // CLAUDE.md in the workspace is a symlink to the repo's own file (the repo is untouched).
  expect(lstatSync(ws.claude).isSymbolicLink()).toBe(true);
  expect(readFileSync(ws.claude, "utf8")).toBe("repo rules");

  writeFileSync(p.soul, "# Soul\n- Reply like a pirate.\n");
  writeFileSync(ws.memory, "# mine\n");
  ensureHome(env.home, loadRepoRegistry(env.home));
  expect(readFileSync(p.soul, "utf8")).toContain("pirate");
  expect(readFileSync(ws.memory, "utf8")).toBe("# mine\n");
});

test("persona: workspace files override the shared defaults; no repo = shared only", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addWorkspace(env.home, "api");
  ensureHome(env.home, loadRepoRegistry(env.home));
  const p = workspacePaths(env.home);
  const shared = buildPersonaContext(env.home);
  expect(shared).toContain("Name: Friday");
  expect(shared).toContain("Vietnamese");
  // The workspace has its own IDENTITY (auto-created) but no SOUL: soul falls back to the shared one.
  const forApi = buildPersonaContext(env.home, "api");
  expect(forApi).toContain("working on the repo `api`");
  expect(forApi).toContain("Vietnamese");
  writeFileSync(p.workspace("api").soul, "# Soul\n- Be terse.\n");
  const terse = buildPersonaContext(env.home, "api");
  expect(terse).toContain("Be terse");
  expect(terse).not.toContain("Vietnamese");
});
