import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { buildPersonaContext, cutMiddle, ensureHome } from "../src/memory/persona";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { addLocation, clearWorkspaces, makeEnv } from "./helpers";

test("ensureHome creates defaults + channel memory once (no workspace or location memory), never overwrites, no CLAUDE.md", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const location = addLocation(env.home, "api", { description: "billing api" });
  writeFileSync(join(location, "CLAUDE.md"), "location rules");
  const p = workspacePaths(env.home);
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  const ws = p.workspace("main");
  for (const f of [p.identity, p.soul, p.memory, ws.channel("main-agent").memory])
    expect(existsSync(f)).toBe(true);
  // The retired layers get no file.
  expect(existsSync(join(ws.root, "MEMORY.md"))).toBe(false);
  expect(existsSync(join(ws.locations, "api", "MEMORY.md"))).toBe(false);
  expect(existsSync(ws.cwd)).toBe(true);
  expect(existsSync(ws.identity)).toBe(false); // no per-workspace identity
  expect(readFileSync(p.user, "utf8")).toContain("Vietnamese");
  // No CLAUDE.md anywhere above a clone (home, workspaces, workspace, location dir): the SDK would load it.
  const found = readdirSync(env.home, { recursive: true, withFileTypes: true })
    .filter((e) => e.name === "CLAUDE.md")
    .map((e) => join(e.parentPath, e.name));
  expect(found).toEqual([join(location, "CLAUDE.md")]); // only the location's own file

  writeFileSync(p.soul, "# Soul\n- Reply like a pirate.\n");
  writeFileSync(ws.channel("main-agent").memory, "# mine\n");
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  expect(readFileSync(p.soul, "utf8")).toContain("pirate");
  expect(readFileSync(ws.channel("main-agent").memory, "utf8")).toBe("# mine\n");
});

test("ensureHome creates a missing channel memory folder (a channel added to workspace.yaml by hand)", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(
    env.home,
    "api",
    { description: "billing api" },
    { path: mkdtempSync(join(tmpdir(), "friday-loc-")) },
  );
  const mem = workspacePaths(env.home).workspace("main").channel("main-agent").memory;
  rmSync(dirname(mem), { recursive: true, force: true });
  ensureHome(env.home, loadWorkspaces(env.home).workspaces);
  expect(readFileSync(mem, "utf8")).toContain("main-agent");
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

test("persona: order is AGENTS, IDENTITY, SOUL, USER; a file over 8000 chars is cut in the middle and flagged", () => {
  const env = makeEnv();
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  writeFileSync(p.agents, "# Agents\n- AGENTS_MARK\n");
  writeFileSync(p.user, `# User\n- USER_MARK\n${"x\n".repeat(5000)}- USER_TAIL\n`);
  const r = buildPersonaContext(env.home);
  const at = (m: string) => r.text.indexOf(m);
  expect(at("AGENTS_MARK")).toBeLessThan(at("Name: Friday"));
  expect(at("Name: Friday")).toBeLessThan(at("# Soul"));
  expect(at("# Soul")).toBeLessThan(at("USER_MARK"));
  // One `<file name="…">` per file in the order, inside `<owner_files>`; the file's own headings are kept as written.
  expect(r.text.startsWith('<owner_files>\n<file name="AGENTS.md">\n# Agents')).toBe(true);
  expect(r.text.endsWith("</file>\n</owner_files>")).toBe(true);
  const heads = ["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md"].map((f) =>
    at(`<file name="${f}">`),
  );
  expect(heads.every((h) => h >= 0)).toBe(true);
  expect(heads).toEqual([...heads].sort((a, b) => a - b));
  expect(r.truncated).toBe(true);
  expect(r.text).toContain("chars cut from the middle of USER.md; keep it shorter");
  expect(r.text).toContain("USER_TAIL"); // the tail is kept

  expect(buildPersonaContext(env.home).text).not.toContain("BOOTSTRAP");
});

test("persona: <file> tags list only the files that have content; <team> comes after the owner files", () => {
  const env = makeEnv();
  ensureHome(env.home, []);
  const p = workspacePaths(env.home);
  writeFileSync(p.soul, "# Soul\n- Be brief.\n");
  writeFileSync(p.identity, "# Identity\n");
  writeFileSync(p.user, "<!-- nothing -->");
  writeFileSync(p.agents, "# Agents\n"); // an emptied AGENTS.md (the default one carries the commit rule)
  const { text } = buildPersonaContext(env.home);
  expect(text).toContain('<file name="SOUL.md">');
  for (const f of ["AGENTS.md", "IDENTITY.md", "USER.md"]) expect(text).not.toContain(f);
  const withTeam = buildPersonaContext(env.home, undefined, undefined, "## Members").text;
  expect(withTeam.endsWith("</owner_files>\n\n<team>\n## Members\n</team>")).toBe(true);
  writeFileSync(p.soul, "<!-- nothing -->");
  expect(buildPersonaContext(env.home).text).toBe("");
});

test("cutMiddle: 70% head and 30% tail on line borders, marker in between; short text unchanged", () => {
  expect(cutMiddle("short", 100, "A.md")).toBe("short");
  const body = Array.from({ length: 100 }, (_, n) => `line ${n}`).join("\n");
  const out = cutMiddle(body, 400, "A.md");
  const [head, tail] = out.split(
    /\n\[\.\.\. \d+ chars cut from the middle of A\.md; keep it shorter \.\.\.\]\n/,
  );
  expect(head?.startsWith("line 0\n")).toBe(true);
  expect(tail?.endsWith("line 99")).toBe(true);
  expect(head!.length).toBeLessThanOrEqual(280);
  expect(tail!.length).toBeLessThanOrEqual(120);
  expect(head!.endsWith("\n") || tail!.startsWith("\n")).toBe(false); // whole lines on both sides
  expect(body).toContain(`${head}\n`);
  expect(body).toContain(`\n${tail}`);
});
