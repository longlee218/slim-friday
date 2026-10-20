import { expect, test } from "bun:test";
import { STALE_AFTER_MS } from "../src/config/resilience-caps";
import { NO_SHELL_WRITER_FACT } from "../src/roles/builtin/worker-contract";
import { ROLES } from "../src/roles/role-registry";

/* Phase 2b: every worker contract is a full working guide (template sections, facts from role data), the shared worker
   block is in every task worker and nowhere else, and each contract stays under a per-role ceiling (measured size + ~10%,
   rounded up to 100; replaces the old 1200-char per-section budget). */

/** The joined contract of a role as a run sends it (with a worktrees dir, so the developer's longest form is measured). */
const contract = (name: string): string =>
  ROLES[name]?.promptSections({ worktreesDir: "/w/worktrees" }).join("\n") ?? "";

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

/** Contract ceilings in chars (measured 2026-10-20 + ~10%). Raise one with its measured size when a contract grows. */
const CEILING: Record<string, number> = {
  developer: 17300,
  tester: 12300,
  "solution-architect": 11000,
  designer: 10900,
  devops: 11200,
  "humanizer-writer": 10700,
  hacker: 11000,
  scout: 10600,
  researcher: 10400,
  planner: 8500,
  "discord-manager": 4300,
  lead: 3600,
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
    "## Method",
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
  }
});

test("the shared worker block is in every task worker once, never in the lead, planner or discord-manager", () => {
  for (const name of TASK_WORKERS)
    expect(contract(name).split("## How the team works")).toHaveLength(2);
  for (const name of ["lead", "planner", "discord-manager"])
    expect(contract(name)).not.toContain("## How the team works");
  expect(contract("tester")).toContain(`${STALE_AFTER_MS / 60_000} minutes is aborted as stale`);
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
  // Per-item plan approval stays, inside an approved plan and for fix-N.
  expect(contract("developer")).toContain("for a fix-N item too");
  // Method-skill documents: writing roles file them in docs/, others return them.
  expect(contract("scout")).toContain("the next writing role files it in docs/");
});

test("scout and researcher split: lookups vs web research", () => {
  expect(contract("scout")).toContain("path:line");
  expect(contract("scout")).toContain("researcher");
  expect(contract("researcher")).toContain("(files, symbols, call paths: scout)");
});
