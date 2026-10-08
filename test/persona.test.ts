import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { buildPersonaContext, ensureHome } from "../src/memory/persona";
import { loadRepoRegistry } from "../src/workspaces/workspace-registry";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

test("ensureHome creates defaults + per-workspace files once and never overwrites", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const repo = addRepo(env.home, "api", { description: "billing api" });
  writeFileSync(join(repo, "CLAUDE.md"), "repo rules");
  const p = workspacePaths(env.home);
  ensureHome(env.home, loadRepoRegistry(env.home));
  const ws = p.legacyWorkspace("api");
  for (const f of [p.identity, p.soul, ws.identity, ws.memory]) expect(existsSync(f)).toBe(true);
  expect(existsSync(ws.logs)).toBe(true);
  expect(readFileSync(ws.identity, "utf8")).toContain("billing api");
  expect(readFileSync(p.user, "utf8")).toContain("Vietnamese");
  // CLAUDE.md in the workspace is a symlink to the repo's own file (the repo is untouched).
  expect(lstatSync(ws.claude).isSymbolicLink()).toBe(true);
  expect(readFileSync(ws.claude, "utf8")).toBe("repo rules");

  writeFileSync(p.soul, "# Soul\n- Reply like a pirate.\n");
  writeFileSync(ws.memory, "# mine\n");
  ensureHome(env.home, loadRepoRegistry(env.home));
  expect(readFileSync(p.soul, "utf8")).toContain("pirate");
  expect(readFileSync(ws.memory, "utf8")).toBe("# mine\n");
});

test("ensureHome creates AGENTS/USER/MEMORY/BOOTSTRAP once and never overwrites edits", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  for (const f of [p.agents, p.user, p.memory, p.bootstrap]) expect(existsSync(f)).toBe(true);
  expect(readFileSync(p.user, "utf8")).toContain("Vietnamese");
  expect(readFileSync(p.soul, "utf8")).not.toContain("Vietnamese");
  writeFileSync(p.user, "# User\n- mine\n");
  ensureHome(env.home, []);
  expect(readFileSync(p.user, "utf8")).toContain("mine");
});

test("persona: workspace files replace root per file; templates and comments inject nothing", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addRepo(env.home, "api");
  ensureHome(env.home, loadRepoRegistry(env.home));
  const p = workspacePaths(env.home);
  const shared = buildPersonaContext(env.home);
  expect(shared.text).toContain("Name: Friday");
  expect(shared.text).toContain("Vietnamese"); // from USER
  expect(shared.text).not.toContain("<!--"); // comments stripped
  expect(shared.text).not.toContain("# Agents"); // heading-only AGENTS = empty
  // The workspace has its own IDENTITY (auto-created) but no SOUL/USER: they fall back to root.
  const forApi = buildPersonaContext(env.home, "api");
  expect(forApi.text).toContain("working on the repo `api`");
  expect(forApi.text).toContain("Vietnamese");
  const ws = p.legacyWorkspace("api");
  writeFileSync(ws.user, "# User\n- Reply in English.\n");
  writeFileSync(ws.soul, "<!-- nothing yet -->");
  const en = buildPersonaContext(env.home, "api").text;
  expect(en).toContain("Reply in English");
  expect(en).not.toContain("Vietnamese");
  expect(en).toContain("Concise, direct"); // empty workspace SOUL -> root SOUL
});

test("persona: order is AGENTS, IDENTITY, SOUL, USER; a file over 1500 chars is cut and flagged", () => {
  const env = makeEnv();
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.user, `# User\n- USER_MARK\n${"x".repeat(2000)}`);
  const r = buildPersonaContext(env.home);
  const at = (m: string) => r.text.indexOf(m);
  expect(at("AGENTS_MARK")).toBeLessThan(at("Name: Friday"));
  expect(at("Name: Friday")).toBeLessThan(at("# Soul"));
  expect(at("# Soul")).toBeLessThan(at("USER_MARK"));
  expect(r.truncated).toBe(true);
  expect(r.text).toContain("(truncated)");
  expect(buildPersonaContext(env.home).text).not.toContain("BOOTSTRAP");
});
