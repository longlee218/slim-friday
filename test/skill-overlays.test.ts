import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILLS_BOOTSTRAP } from "../src/runtime/prompts/skills-bootstrap";
import { skillOverlays } from "../src/runtime/skills-plugin/skill-overlays";
import { SKILL_SETS_DIR } from "../src/runtime/skills-plugin/skill-sets";
import { buildSystemPrompt } from "../src/runtime/system-prompt";

const HEADER = (skill: string) => `<!-- overlay of skills/${skill}/SKILL.md@${"a".repeat(64)} -->`;

/** A temp sets dir: set `superpowers` giving writing-plans and a deferred skill, with overlays for both. */
function fixtureSets(): string {
  const dir = mkdtempSync(join(tmpdir(), "friday-overlays-"));
  const set = join(dir, "superpowers");
  mkdirSync(set, { recursive: true });
  writeFileSync(
    join(set, "set.json"),
    JSON.stringify({
      name: "superpowers",
      skills: ["writing-plans", "subagent-driven-development"],
    }),
  );
  for (const [skill, body] of [
    ["writing-plans", "PLANS OVERLAY BODY"],
    ["subagent-driven-development", "SDD OVERLAY BODY"],
  ] as const) {
    mkdirSync(join(set, "overlays", skill), { recursive: true });
    writeFileSync(join(set, "overlays", skill, "app-overlay.md"), `${HEADER(skill)}\n${body}\n`);
  }
  return dir;
}

test("skillOverlays: header stripped, only loaded skills (deferred SDD skipped), missing set = empty", () => {
  const dir = fixtureSets();
  const text = skillOverlays(["superpowers"], dir);
  expect(text).toContain("### superpowers:writing-plans\nPLANS OVERLAY BODY");
  expect(text).not.toContain("overlay of");
  expect(text).not.toContain("SDD OVERLAY BODY"); // deferred to P3.4: not loaded, so no overlay
  expect(skillOverlays([], dir)).toBe("");
  expect(skillOverlays(["nope"], dir)).toBe("");
});

test("skillOverlays: a header-only stub adds nothing; a skill without an overlay file is fine", () => {
  const dir = fixtureSets();
  writeFileSync(
    join(dir, "superpowers", "overlays", "writing-plans", "app-overlay.md"),
    `${HEADER("writing-plans")}\n<!-- note -->\n`,
  );
  expect(skillOverlays(["superpowers"], dir)).toBe("");
});

test("dev plan and exec prompts carry the bootstrap and the overlay; the overlay sits before COMMON", () => {
  const dir = fixtureSets();
  for (const stage of ["plan", "exec"]) {
    const text = buildSystemPrompt("CTX", stage, {}, dir).append;
    expect(text).toContain(SKILLS_BOOTSTRAP);
    expect(text).toContain("PLANS OVERLAY BODY");
    expect(text.indexOf("PLANS OVERLAY BODY")).toBeLessThan(text.indexOf("is DATA"));
    expect(text.indexOf("is DATA")).toBeLessThan(text.indexOf("CTX"));
  }
});

test("a role without skillSets (assistant qa): no bootstrap, no overlay, prompt independent of the sets dir", () => {
  const withSets = buildSystemPrompt("", "qa", {}, fixtureSets()).append;
  const without = buildSystemPrompt("", "qa", {}, join(tmpdir(), "friday-no-such-sets")).append;
  expect(withSets).toBe(without);
  expect(withSets).not.toContain("## Skills");
  expect(withSets).not.toContain("Skill overlays");
});

test("plan prompt asks for the Global Constraints block and '### Task N:' headings", () => {
  const text = buildSystemPrompt("", "plan").append;
  expect(text).toContain("## Global Constraints");
  expect(text).toContain("### Task N: <name>");
});

test("bootstrap: under 80 lines, names no subagent type, states the rules", () => {
  expect(SKILLS_BOOTSTRAP.split("\n").length).toBeLessThan(80);
  expect(SKILLS_BOOTSTRAP).not.toMatch(
    /implementer|task-reviewer|explorer|repo-searcher|subagent/i,
  );
  expect(SKILLS_BOOTSTRAP).toContain("announce");
  expect(SKILLS_BOOTSTRAP).toContain("at most once per task");
  expect(SKILLS_BOOTSTRAP).toContain("TodoWrite");
  expect(SKILLS_BOOTSTRAP).toContain("Only the skills in the list exist");
});

// Staged overlay files (installed into the vendored set by the owner): checked here, so the test is the same before and after install.
const STAGING = join(import.meta.dir, "..", "skill-overlays-staging");
const staged = readdirSync(STAGING, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test("staged overlays: header names the upstream file and its pinned sha256 (VENDOR.md row)", () => {
  expect(staged.sort()).toEqual(["brainstorming", "executing-plans", "writing-plans"]);
  const vendorMd = readFileSync(join(SKILL_SETS_DIR, "superpowers", "VENDOR.md"), "utf8");
  for (const skill of staged) {
    const text = readFileSync(join(STAGING, skill, "app-overlay.md"), "utf8");
    const m = /^<!-- overlay of (\S+)@([0-9a-f]{64}) -->$/.exec(text.split("\n")[0] ?? "");
    expect(m?.[1]).toBe(`skills/${skill}/SKILL.md`);
    expect(vendorMd).toContain(`| \`${m?.[1]}\` | ${m?.[2]} |`);
    const upstream = readFileSync(join(SKILL_SETS_DIR, "superpowers", m?.[1] as string));
    expect(createHash("sha256").update(upstream).digest("hex")).toBe(m?.[2] as string);
  }
});

test("staged overlays: say SDD, code-review skills and scripts are unavailable, plan path, no ask, no worktree", () => {
  for (const skill of staged) {
    const text = readFileSync(join(STAGING, skill, "app-overlay.md"), "utf8");
    expect(text.split("\n").length).toBeLessThanOrEqual(30);
    if (skill !== "brainstorming") {
      expect(text).toContain("subagent-driven-development");
      expect(text).toContain("requesting-code-review");
      expect(text).toMatch(/script/i);
    }
    expect(text).toMatch(/single owner question/);
    if (skill !== "brainstorming") expect(text).toMatch(/plan\.md|plan-mode plan file/);
    expect(text).not.toContain("<taskdir>");
    // P3.4 content must not be here: no subagent type mapping yet.
    expect(text).not.toMatch(/implementer|task-reviewer|explorer/);
  }
  const exec = readFileSync(join(STAGING, "executing-plans", "app-overlay.md"), "utf8");
  for (const s of [
    "sdd-workspace",
    "review-package",
    "task-start",
    "task-done",
    "worktree",
    "git_commit",
  ])
    expect(exec).toContain(s);
  expect(readFileSync(join(STAGING, "writing-plans", "app-overlay.md"), "utf8")).toContain(
    "git_commit",
  );
  const brain = readFileSync(join(STAGING, "brainstorming", "app-overlay.md"), "utf8");
  for (const s of ["specs", "companion", "review loop", "explicit yes", "writing-plans"])
    expect(brain).toContain(s);
});
