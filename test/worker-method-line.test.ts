import { expect, test } from "bun:test";
import { DEVELOPER } from "../src/roles/builtin/developer-role";
import { SPECIALIST_CONTRACT } from "../src/roles/builtin/specialist-contract";
import {
  DEVELOPER_METHOD_LINE,
  PLANNER_METHOD_LINE,
  WORKER_METHOD_LINE,
} from "../src/roles/builtin/worker-method";
import { ROLES } from "../src/roles/role-registry";

/** The sections of a role's contract as a run sends them. */
const contract = (name: string) => ROLES[name]?.promptSections({} as never).join("\n") ?? "";

test("the Method line is in the specialist, scout, planner and developer contracts, once", () => {
  expect(SPECIALIST_CONTRACT).toContain(WORKER_METHOD_LINE);
  for (const name of [
    "solution-architect",
    "designer",
    "tester",
    "devops",
    "humanizer-writer",
    "hacker",
    "scout",
  ])
    expect(contract(name)).toContain(WORKER_METHOD_LINE);
  expect(contract("planner")).toContain(PLANNER_METHOD_LINE);
  expect(DEVELOPER).toContain(DEVELOPER_METHOD_LINE);
  for (const c of [SPECIALIST_CONTRACT, DEVELOPER]) expect(c.split("- Method:")).toHaveLength(2);
});

test("the Method line names no skill and is the same text for the planner except 'plan'", () => {
  expect(WORKER_METHOD_LINE).toContain("call the Skill tool for every listed skill");
  expect(PLANNER_METHOD_LINE).toBe(WORKER_METHOD_LINE.replace("plan or change anything", "plan"));
});
