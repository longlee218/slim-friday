import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STALE_AFTER_MS } from "../src/config/resilience-caps";
import { NO_SHELL_WRITER_FACT } from "../src/roles/builtin/worker-contract";
import { ROLES } from "../src/roles/role-registry";

/* Phase 2b: every worker contract is a full working guide (template sections, facts from role data), the shared worker
   block is in every task worker and nowhere else, and each contract stays under a per-role ceiling (measured size + ~10%,
   rounded up to 100; replaces the old 1200-char per-section budget). */

/** The preloaded team skill: the run facts every task worker gets. */
const TEAM_SKILL_TEXT = readFileSync(
  join(import.meta.dir, "..", ".agents", "skills", "team-protocol", "SKILL.md"),
  "utf8",
);

/** The joined contract of a role as a run sends it. */
const contract = (name: string): string => ROLES[name]?.promptSections().join("\n") ?? "";

/** Task workers: the developer, the roster, the scout and the researcher. */
const TASK_WORKERS = [
  "developer",
  "tester",
  "solution-architect",
  "designer",
  "devops",
  "humanizer-writer",
  "hacker",
  "scout",
  "researcher",
];

/** Contract ceilings in chars (measured 2026-10-22 after the team facts moved to the team skill, + ~10%). Raise one with its measured size when a contract grows. */
const CEILING: Record<string, number> = {
  developer: 10500,
  tester: 8500,
  "solution-architect": 6800,
  designer: 6800,
  devops: 6700,
  "humanizer-writer": 6400,
  hacker: 6700,
  scout: 6600,
  researcher: 6900,
  "discord-manager": 4300,
  lead: 3800,
};

test("every role has a ceiling and stays under it", () => {
  expect(Object.keys(CEILING).sort()).toEqual(Object.keys(ROLES).sort());
  for (const [name, max] of Object.entries(CEILING))
    expect({ name, chars: contract(name).length }).toEqual({
      name,
      chars: Math.min(contract(name).length, max),
    });
});

test("worker contracts have the template sections in order", () => {
  const heads = [
    "## Mission",
    "## How the team works",
    "## Scope",
    "## Definition of done",
    "## Deliverable",
    "## Environment facts",
    "## Stop, ask or fail",
  ];
  for (const name of TASK_WORKERS) {
    const text = contract(name);
    const at = heads.map((h) => text.indexOf(h));
    expect({ name, missing: heads.filter((_, i) => at[i]! < 0) }).toEqual({ name, missing: [] });
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // "## Method" exists only where text remains besides the Method line (the preloaded skill carries the rule).
    const method = text.indexOf("## Method");
    if (method >= 0) {
      expect(method).toBeGreaterThan(text.indexOf("## Mission"));
      expect(method).toBeLessThan(text.indexOf("## How the team works"));
    }
  }
});

test("the shared worker block is in every task worker once, never in the lead, planner or discord-manager", () => {
  for (const name of TASK_WORKERS)
    expect(contract(name).split("## How the team works")).toHaveLength(2);
  for (const name of ["lead", "planner", "discord-manager"])
    expect(contract(name)).not.toContain("## How the team works");
  // The run facts (watchdog, limits, failures) live in the preloaded team skill, not in the contracts.
  expect(TEAM_SKILL_TEXT).toContain(`${STALE_AFTER_MS / 60_000} minutes is aborted as stale`);
});

test("numbers in the contracts match the role data", () => {
  // Budget and turn numbers stay out of every prompt: code enforces them, a model cannot track them.
  for (const name of [...TASK_WORKERS, "planner", "discord-manager"])
    expect(contract(name)).not.toMatch(/\$\d+ budget|\d+ turns/);
  expect(contract("developer")).toContain(`at most ${ROLES.developer!.limits.maxAsk} per run`);
  expect(contract("developer")).toContain(
    `up to ${ROLES.developer!.subagents.parallel} in parallel`,
  );
  expect(contract("tester")).toContain(`Up to ${ROLES.tester!.subagents.parallel} subagents`);
  expect(contract("discord-manager")).toContain(
    `at most ${ROLES["discord-manager"]!.limits.maxAsk} per run`,
  );
});

test("owner decisions: no-shell writers complete without committing; shell roster roles commit only locally", () => {
  expect(contract("humanizer-writer")).toContain(NO_SHELL_WRITER_FACT);
  // The designer has a shell since phase 2c (owner 2026-10-20): it commits like tester and devops, never "no shell".
  expect(contract("designer")).not.toContain(NO_SHELL_WRITER_FACT);
  for (const name of ["tester", "devops", "designer"]) {
    expect(contract(name)).toContain("only when the brief asks, a local commit");
    expect(contract(name)).toContain(
      "Push, merge, PR and deleting existing files are the developer's",
    );
  }
  // The brief carries the approved plan: no per-item plan approval.
  expect(contract("developer")).toContain("Write no plan file of your own");
  // Method-skill documents: writing roles file them in docs/ (or scratch) and list them in `files`; no worker saves artifacts.
  expect(TEAM_SKILL_TEXT).toContain("You cannot save artifacts");
});

test("scout and researcher split: lookups vs web research", () => {
  expect(contract("scout")).toContain("path:line");
  expect(contract("scout")).toContain("researcher");
  expect(contract("researcher")).toContain("(files, symbols, call paths: scout)");
});
