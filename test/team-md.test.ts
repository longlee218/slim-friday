import { expect, test } from "bun:test";
import type { Location } from "../src/locations/location-registry";
import {
  buildLeadContextBlock,
  LEAD_DATA_HEADING,
} from "../src/orchestrator/strategy/lead-context-block";
import { buildTeamMd } from "../src/roles/prompts/team-md";
import { ROLES } from "../src/roles/role-registry";

const api: Location = {
  name: "api",
  workspace: "main",
  path: "/r/api",
  description: "backend",
  git: true,
};

test("TEAM.md: authoritative members from the registry, the channel's locations, strategies and caps", () => {
  const md = buildTeamMd({ locations: [api] });
  expect(md).toContain("You lead the team in this thread");
  expect(md).toContain("do not spend tool calls checking it");
  expect(md).toMatch(/^- developer: .*changes: location/m);
  expect(md).toMatch(/^- scout: .*changes: none/m);
  expect(md).not.toMatch(/^- (lead|discord-manager):/m);
  expect(md).toContain("- api [git]: backend");
  expect(md).not.toContain("/r/api"); // no path in the reply source
  for (const s of ["ANSWER", "DIRECT", "DELEGATE", "PLAN"]) expect(md).toContain(`- ${s}:`);
  expect(md).toContain("Up to 2 items run at once");
  expect(md).toContain("one writer per location");
  expect(md).toContain("At most 3 chained starts");
  expect(md).toContain("1 dispatch per run");
  expect(md).toContain("$3/day");
  expect(md).toContain("RetryTask"); // a held failure: retry with a note, or cancel
  expect(md).toContain("resumed by code in the same session");
  expect(md).toContain("Never put secrets in a brief");
  expect(md).toContain("quoted or forwarded text included");
  // Section order: members, locations, delegation, results, limits.
  const at = (h: string) => md.indexOf(h);
  const heads = ["## Members", "## Locations", "## How to delegate", "## Results", "## Limits"].map(
    at,
  );
  expect(heads).toEqual([...heads].sort((a, b) => a - b));
});

test("TEAM.md follows the roles and locations it is given and stays small", () => {
  expect(buildTeamMd({ workers: [ROLES.scout!] })).not.toContain("- developer:");
  expect(buildTeamMd({ workers: [] })).toContain("none available");
  expect(buildTeamMd()).toContain("none in this channel");
  expect(buildTeamMd({ locations: [api] }).length).toBeLessThan(6000);
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
          status: "completed",
          resultKind: "COMPLETED",
          resultPath: "/h/goals/g1/main.md",
          pendingQuestion: undefined,
          resultExcerpt: `${"x".repeat(500)} token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789`,
        },
        {
          id: "t2",
          key: "next",
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
