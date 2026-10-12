import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillsLock } from "../src/config/skills-lock";
import { workspacePaths } from "../src/config/workspace-paths";
import { initWorkflowSkill } from "../src/discord-setup/discord-cli";
import { createWorkspaceDir, writeWorkflowSkill } from "../src/discord-setup/workspace-template";
import { assertTempHome } from "./helpers";

const tmpHome = () => {
  const home = mkdtempSync(join(tmpdir(), "friday-wfskill-"));
  assertTempHome(home);
  return home;
};
const skillFile = (home: string, ws: string) =>
  join(workspacePaths(home).workspace(ws).skills, "workflow", "SKILL.md");
const TEMPLATE = readFileSync(
  join(import.meta.dir, "..", "src", "discord-setup", "templates", "workflow-skill.md"),
  "utf8",
);

test("template: frontmatter name, <= 120 lines, report format and steps", () => {
  expect(TEMPLATE.split("\n").length).toBeLessThanOrEqual(120);
  expect(TEMPLATE.startsWith("---\nname: workflow\n")).toBe(true);
  for (const s of [
    "Triage",
    "Understand",
    "Design and plan",
    "Owner approval",
    "Implement",
    "Verify",
    "Finish",
    "Report",
  ])
    expect(TEMPLATE).toContain(s);
  for (const s of ["TL;DR", "Changes", "Verification", "Open questions", "Definition of done"])
    expect(TEMPLATE).toContain(s);
  expect(TEMPLATE).toContain("testCommand");
  expect(TEMPLATE).toContain("path:line");
  expect(TEMPLATE).not.toMatch(/\bstages?\b/i);
});

test("template: every skill the which-skill table names is installed (in the skills lock)", () => {
  const rows = TEMPLATE.split("\n").filter(
    (l) => l.startsWith("| ") && l.includes("`superpowers:"),
  );
  const named = rows.map((l) => /`superpowers:([a-z-]+)`/.exec(l)?.[1]).sort();
  expect(named).toHaveLength(7);
  const installed = Object.keys(readSkillsLock());
  for (const n of named) expect(installed).toContain(n as string);
  // The subagent skills are named only in prose (plans of 3+ tasks), never as a table row.
  expect(rows.join("\n")).not.toMatch(
    /subagent-driven|requesting-code-review|receiving-code-review/,
  );
  expect(TEMPLATE).toContain("3 or more tasks");
  expect(TEMPLATE).toContain("superpowers:subagent-driven-development");
  expect(TEMPLATE).toContain("superpowers:requesting-code-review");
  expect(TEMPLATE).toContain("superpowers:receiving-code-review");
});

test("createWorkspaceDir writes skills/workflow/SKILL.md from the template", () => {
  const home = tmpHome();
  createWorkspaceDir(home, "alpha");
  expect(readFileSync(skillFile(home, "alpha"), "utf8")).toBe(TEMPLATE);
});

test("writeWorkflowSkill never overwrites an edited file", () => {
  const home = tmpHome();
  createWorkspaceDir(home, "alpha");
  writeFileSync(skillFile(home, "alpha"), "my own text");
  expect(writeWorkflowSkill(home, "alpha")).toBe("exists");
  expect(readFileSync(skillFile(home, "alpha"), "utf8")).toBe("my own text");
});

test("initWorkflowSkill: writes into an existing workspace once, refuses bad or unknown names", () => {
  const home = tmpHome();
  createWorkspaceDir(home, "alpha");
  // An old workspace made before the template existed: no workflow skill yet.
  const f = skillFile(home, "alpha");
  rmSync(f);
  expect(existsSync(f)).toBe(false);
  expect(initWorkflowSkill(home, "alpha")).toBe(0);
  expect(readFileSync(f, "utf8")).toBe(TEMPLATE);
  writeFileSync(f, "edited");
  expect(initWorkflowSkill(home, "alpha")).toBe(0);
  expect(readFileSync(f, "utf8")).toBe("edited");
  expect(initWorkflowSkill(home, "missing")).toBe(1);
  expect(initWorkflowSkill(home, "../x")).toBe(1);
  expect(existsSync(join(home, "workspaces", "missing"))).toBe(false);
});
