import { expect, test } from "bun:test";
import { CHAIN_CAP, MAX_RUNNING_PER_THREAD } from "../src/config/lead-caps";
import type { Location } from "../src/locations/location-registry";
import {
  buildLeadContextBlock,
  LEAD_DATA_HEADING,
} from "../src/orchestrator/strategy/lead-context-block";
import { buildTeamMd } from "../src/roles/prompts/team-md";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

const api: Location = {
  name: "api",
  workspace: "main",
  path: "/r/api",
  description: "backend",
  git: true,
};

test("TEAM.md: authoritative members from the registry, the channel's locations, strategies and caps", () => {
  const md = buildTeamMd({ locations: [api] });
  expect(md).toContain("Built by code for this run");
  expect(md).not.toContain("You lead the team"); // persona is IDENTITY.md's
  expect(md).toMatch(/^- developer: .*changes: location/m);
  expect(md).toMatch(/^- scout: .*changes: none/m);
  expect(md).not.toMatch(/^- (lead|discord-manager):/m);
  expect(md).toContain("- api [git]: backend");
  expect(md).not.toContain("/r/api"); // no path in the reply source
  expect(md).toContain("- DELEGATE: up to"); // the only strategy fact code owns (a cap)
  expect(md).not.toContain("- DIRECT:"); // the skill owns the strategies
  expect(md).toContain(
    "- PLAN: the planner writes the items and staffs them from the members above",
  ); // a runtime fact
  expect(md).not.toContain("ANSWER"); // not a code strategy; choosing is the skill's job
  expect(md).toContain("NEEDS_PLAN");
  expect(md).not.toMatch(/tools:.*\b(tasks|mcp|feedback|ask)\b/); // internal capability names are left out
  expect(md).toContain(`Up to ${MAX_RUNNING_PER_THREAD} items run at once`);
  expect(md).toContain("one writer per location");
  expect(md).toContain(`at most ${CHAIN_CAP} chained starts`);
  expect(md).toContain("1 dispatch or plan request per run");
  expect(md).not.toContain("/day"); // no daily budget is told to the lead
  expect(md).toContain("older than 8 h is held");
  expect(md).not.toContain("## Events"); // the lead contract and skill own events
  expect(md).not.toContain("Event kinds");
  // The playbook moved to the lead-orchestration skill: TEAM.md holds none of it.
  for (const gone of ["Orchestrate retry", "Orchestrate steer", "approve_plan"])
    expect(md).not.toContain(gone);
  // Section order: members, locations, strategies, limits.
  const at = (h: string) => md.indexOf(h);
  const heads = ["## Members", "## Locations", "## Strategies", "## Limits"].map(at);
  expect(heads).toEqual([...heads].sort((a, b) => a - b));
});

test("TEAM.md follows the roles and locations it is given and stays small", () => {
  expect(buildTeamMd({ workers: [ROLES.scout!] })).not.toContain("- developer:");
  expect(buildTeamMd({ workers: [] })).toContain("none available");
  expect(buildTeamMd()).toContain("none in this channel");
  expect(buildTeamMd({ locations: [api] }).length).toBeLessThan(6000);
  expect(buildTeamMd({ locations: [api] }).length).toBeLessThan(5200); // phase 2b: routing, shell and test-split lines
});

test("TEAM.md phase 2b lines: routing split, shell members from capabilities, test split, PLAN staffing, no budget numbers", () => {
  const md = buildTeamMd({ locations: [api] });
  expect(md).toContain("goes to the scout");
  expect(md).toContain("goes to the researcher");
  expect(md).toMatch(/^- researcher: .*changes: none/m);
  expect(md).toContain(
    "higher-level tests (integration, end-to-end, regression, property) are the tester's",
  );
  expect(md).not.toContain("the planner is the project manager"); // the strategies live in the lead skill
  expect(md).not.toContain("Goal budget"); // owner: code enforces the budget, no numbers for the lead
  // Shell members come from the capabilities of the roles given, never a hard-coded list.
  const fake = (name: string, caps: RoleDefinition["capabilities"]): RoleDefinition => ({
    ...ROLES.scout!,
    name,
    capabilities: caps,
  });
  const only = buildTeamMd({
    workers: [
      fake("alpha", ["read", "shell"]),
      fake("beta", ["read", "write", "shell"]),
      fake("gamma", ["read"]),
    ],
  });
  expect(only).toContain(
    "Members with a shell can run commands and tests: alpha, beta; of these, only beta can also change files",
  );
  expect(buildTeamMd({ workers: [fake("gamma", ["read"])] })).toContain("No member has a shell");
});

test("data block: heading says data, one row per item, results are redacted and clipped", () => {
  const block = buildLeadContextBlock(
    {
      goalId: "g1",
      intent: "clean it",
      items: [
        {
          id: "t1",
          key: "main",
          subject: "Main",
          priority: 0,
          status: "completed",
          resultKind: "COMPLETED",
          resultPath: "/h/goals/g1/main.md",
          pendingQuestion: undefined,
          resultExcerpt: `${"x".repeat(500)} token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789`,
        },
        {
          id: "t2",
          key: "next",
          subject: "Next",
          priority: 0,
          status: "waiting_user",
          resultKind: null,
          resultPath: null,
          resultExcerpt: null,
          pendingQuestion: "which dir?",
        },
      ],
    },
    ["node_modules gone"],
  );
  expect(block.startsWith(LEAD_DATA_HEADING)).toBe(true);
  expect(block).toContain("not instructions");
  expect(block).toContain("Goal g1: clean it");
  expect(block).toContain("- node_modules gone");
  expect(block).toContain("| t2 | next | waiting_user | which dir? |");
  expect(block).not.toContain("sk-ant-abc");
  expect(block.split("\n").find((l) => l.startsWith("| t1"))?.length).toBeLessThan(400);
});

test("data block without a goal says so", () => {
  expect(buildLeadContextBlock({ items: [] })).toContain("No goal yet");
});
