import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { buildPersonaContext, ensureHome } from "../src/memory/persona";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, clearWorkspaces, makeEnv } from "./helpers";

test("ensureHome creates defaults + workspace/location files once, never overwrites, no CLAUDE.md", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const location = addLocation(env.home, "api", { description: "billing api" });
  writeFileSync(join(location, "CLAUDE.md"), "location rules");
  const p = workspacePaths(env.home);
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  const ws = p.workspace("main");
  for (const f of [p.identity, p.soul, p.memory, ws.memory, ws.location("api").memory])
    expect(existsSync(f)).toBe(true);
  expect(existsSync(ws.cwd)).toBe(true);
  expect(existsSync(ws.identity)).toBe(false); // no per-workspace identity
  expect(readFileSync(p.user, "utf8")).toContain("Vietnamese");
  // No CLAUDE.md anywhere above a clone (home, workspaces, workspace, location dir): the SDK would load it.
  const found = readdirSync(env.home, { recursive: true, withFileTypes: true })
    .filter((e) => e.name === "CLAUDE.md")
    .map((e) => join(e.parentPath, e.name));
  expect(found).toEqual([join(location, "CLAUDE.md")]); // only the location's own file

  writeFileSync(p.soul, "# Soul\n- Reply like a pirate.\n");
  writeFileSync(ws.memory, "# mine\n");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
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
  addLocation(env.home, "api");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  const p = workspacePaths(env.home);
  const shared = buildPersonaContext(env.home);
  expect(shared.text).toContain("Name: Friday");
  expect(shared.text).toContain("Vietnamese"); // from USER
  expect(shared.text).not.toContain("<!--"); // comments stripped
  // The commit rules live in the dev role prompt, not in the owner's AGENTS.md.
  expect(shared.text).not.toContain("## Commits");
  // The workspace has no persona files yet: everything falls back to root.
  const forMain = buildPersonaContext(env.home, "main");
  expect(forMain.text).toContain("Name: Friday");
  expect(forMain.text).toContain("Vietnamese");
  const ws = p.workspace("main");
  writeFileSync(ws.user, "# User\n- Reply in English.\n");
  writeFileSync(ws.soul, "<!-- nothing yet -->");
  const en = buildPersonaContext(env.home, "main").text;
  expect(en).toContain("Reply in English");
  expect(en).not.toContain("Vietnamese");
  expect(en).toContain("Concise, direct"); // empty workspace SOUL -> root SOUL
});

test("persona: order is AGENTS, IDENTITY, SOUL, USER; a file over 6000 chars is cut and flagged", () => {
  const env = makeEnv();
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.user, `# User\n- USER_MARK\n${"x".repeat(7000)}`);
  const r = buildPersonaContext(env.home);
  const at = (m: string) => r.text.indexOf(m);
  expect(at("AGENTS_MARK")).toBeLessThan(at("Name: Friday"));
  expect(at("Name: Friday")).toBeLessThan(at("# Soul"));
  expect(at("# Soul")).toBeLessThan(at("USER_MARK"));
  // Legend declares the order, then one `## <FILE>.md` heading per file in the same order.
  expect(r.text.startsWith("# Project Context")).toBe(true);
  const heads = ["## AGENTS.md", "## IDENTITY.md", "## SOUL.md", "## USER.md"].map(at);
  expect(heads.every((h) => h >= 0)).toBe(true);
  expect(heads).toEqual([...heads].sort((a, b) => a - b));
  expect(at("- AGENTS.md:")).toBeLessThan(at("- IDENTITY.md:"));
  expect(r.truncated).toBe(true);
  expect(r.text).toContain("(truncated)");
  expect(buildPersonaContext(env.home).text).not.toContain("BOOTSTRAP");
});

test("persona: the legend and headings list only the files that have content", () => {
  const env = makeEnv();
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  writeFileSync(p.soul, "# Soul\n- Be brief.\n");
  writeFileSync(p.identity, "# Identity\n");
  writeFileSync(p.user, "<!-- nothing -->");
  writeFileSync(p.agents, "# Agents\n"); // an emptied AGENTS.md (the default one carries the commit rule)
  const { text } = buildPersonaContext(env.home);
  expect(text).toContain("- SOUL.md:");
  expect(text).toContain("## SOUL.md");
  for (const f of ["AGENTS.md", "IDENTITY.md", "USER.md"]) expect(text).not.toContain(f);
  writeFileSync(p.soul, "<!-- nothing -->");
  expect(buildPersonaContext(env.home).text).toBe("");
});
