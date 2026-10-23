import { expect, test } from "bun:test";
import { CHAIN_CAP, MAX_RUNNING_PER_THREAD } from "../src/config/teammate-caps";
import type { Location } from "../src/locations/location-registry";
import {
  buildTeammateContextBlock,
  TEAMMATE_DATA_TAG,
} from "../src/orchestrator/strategy/teammate-context-block";
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
  expect(md).not.toContain("You teammate the team"); // persona is IDENTITY.md's
  expect(md).toMatch(/^\| developer \| .* \| location \|/m);
  expect(md).toMatch(/^\| scout \| .* \| none \|/m);
  expect(md).not.toMatch(/^\| (teammate) \|/m);
  expect(md).toContain("- api [git]: backend");
  expect(md).not.toContain("/r/api"); // no path in the reply source
  expect(md).toContain("- DELEGATE: up to"); // the only strategy fact code owns (a cap)
  expect(md).not.toContain("- DIRECT:"); // the skill owns the strategies
  expect(md).toContain("- PLAN: the teammate writes the plan"); // a runtime fact
  expect(md).not.toContain("ANSWER"); // not a code strategy; choosing is the skill's job
  expect(md).toContain("NEEDS_PLAN");
  expect(md).not.toMatch(/^\|.*\| [^|]*\b(tasks|mcp|feedback|ask|skills)\b[^|]* \|$/m); // internal capability names are left out of Tools
  expect(md).toContain(`Up to ${MAX_RUNNING_PER_THREAD} items run at once`);
  expect(md).toContain("one writer per location");
  expect(md).toContain(`at most ${CHAIN_CAP} chained starts`);
  expect(md).toContain("1 dispatch or plan (create_plan, revise_plan) per run");
  expect(md).not.toContain("/day"); // no daily budget is told to the teammate
  expect(md).toContain("older than 8 h is held");
  expect(md).not.toContain("## Events"); // the teammate contract and skill own events
  expect(md).not.toContain("Event kinds");
  // The playbook moved to the teammate-orchestration skill: TEAM.md holds none of it.
  for (const gone of ["Orchestrate retry", "Orchestrate steer", "approve_plan"])
    expect(md).not.toContain(gone);
  // Section order: members, locations, strategies, limits.
  const at = (h: string) => md.indexOf(h);
  const heads = ["## Members", "## Locations", "## Strategies", "## Limits"].map(at);
  expect(heads).toEqual([...heads].sort((a, b) => a - b));
});

test("TEAM.md follows the roles and locations it is given and stays small", () => {
  expect(buildTeamMd({ workers: [ROLES.scout!] })).not.toContain("| developer |");
  expect(buildTeamMd({ workers: [] })).toContain("none available");
  expect(buildTeamMd()).toContain("none in this channel");
  expect(buildTeamMd({ locations: [api] }).length).toBeLessThan(6000);
  expect(buildTeamMd({ locations: [api] }).length).toBeLessThan(4000); // teammate prompt v2.2: one table, routing as role data
});

test("TEAM.md members table: routing is role data (Use when, Not for), tools and facts come from capabilities", () => {
  const md = buildTeamMd({ locations: [api] });
  expect(md).toContain("| Role | Use when | Not for | Changes | Tools |");
  expect(md).toMatch(/^\| researcher \| .* \| none \| .*browser \|$/m);
  expect(md).toMatch(/^\| developer \| .*integration or end-to-end tests\. \| location \|/m); // the test split is role data
  expect(md).not.toContain("goes to the scout"); // no routing prose: the table and the teammate's skill decide
  expect(md).not.toContain("the planner is the project manager"); // the strategies live in the teammate skill
  expect(md).not.toContain("Goal budget"); // owner: code enforces the budget, no numbers for the teammate
  expect(md).toContain("- Only developer can ask the owner"); // from the `ask` capability, not a name in code
  // Rows come from the roles given: a new role is data only.
  const fake = (
    name: string,
    caps: RoleDefinition["capabilities"],
    notFor?: string,
  ): RoleDefinition => ({
    ...ROLES.scout!,
    name,
    whenToUse: `${name} work | with a pipe`,
    notFor,
    capabilities: caps,
    mcpTools: [],
  });
  const only = buildTeamMd({
    workers: [
      fake("alpha", ["read", "shell"], "beta work"),
      fake("beta", ["read", "write", "shell"]),
    ],
  });
  expect(only).toContain("| alpha | alpha work / with a pipe | beta work | none | read, shell |");
  expect(only).toContain("| beta | beta work / with a pipe | - | none | read, edit, shell |");
  expect(only).toContain("- No member can ask the owner");
  expect(only).not.toContain("screenshot"); // no browser member, no screenshot line
  expect(buildTeamMd({ workers: [fake("gamma", ["read"], "")] })).toContain(
    "No member has a shell",
  );
  expect(buildTeamMd({ workers: [fake("gamma", ["read"], "")] })).toContain(
    "| gamma | gamma work / with a pipe | - |",
  );
});

test("data block: <goal_state> tags, one row per item, results are redacted and clipped", () => {
  const block = buildTeammateContextBlock(
    {
      goalId: "g1",
      intent: "clean it",
      items: [
        {
          id: "t1",
          key: "main",
          role: "developer",
          subject: "Main",
          priority: 0,
          status: "completed",
          resultKind: "COMPLETED",
          resultMessage: "M12",
          pendingQuestion: undefined,
          resultExcerpt: `${"x".repeat(500)} token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789`,
        },
        {
          id: "t2",
          key: "next",
          role: "developer",
          subject: "Next",
          priority: 0,
          status: "waiting_user",
          resultKind: null,
          resultMessage: null,
          resultExcerpt: null,
          pendingQuestion: "which dir?",
        },
      ],
    },
    ["node_modules gone"],
  );
  expect(block.startsWith(TEAMMATE_DATA_TAG)).toBe(true);
  expect(block.endsWith("</goal_state>")).toBe(true);
  expect(block).toContain("Goal g1: clean it");
  expect(block).toContain("- node_modules gone");
  expect(block).toContain("| t2 | next | waiting_user | which dir? |");
  expect(block).not.toContain("sk-ant-abc");
  expect(block.split("\n").find((l) => l.startsWith("| t1"))?.length).toBeLessThan(400);
});

test("data block without a goal says so", () => {
  expect(buildTeammateContextBlock({ items: [] })).toContain("No goal yet");
});
