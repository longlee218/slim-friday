import { expect, test } from "bun:test";
import { ROLES } from "../src/roles/role-registry";

/** The sections of a role's contract as a run sends them. */
const contract = (name: string) => ROLES[name]?.promptSections({} as never).join("\n") ?? "";

/** The part of the Method line every worker contract shares; no skill name in it. */
const METHOD = "- Method: the skills listed for this run are how you work. Before you ";
const CALL = "call the Skill tool for every listed skill whose description matches the request";

test("every role except the lead has the Method line in its contract, once, naming no skill", () => {
  for (const name of Object.keys(ROLES).filter((n) => n !== "lead")) {
    const c = contract(name);
    expect(c.split("- Method:"), name).toHaveLength(2);
    expect(c, name).toContain(METHOD);
    expect(c, name).toContain(CALL);
  }
});

test("the planner's Method line precedes 'plan' only, the developer's says where its plan comes from", () => {
  expect(contract("planner")).toContain(`${METHOD}plan, ${CALL}`);
  expect(contract("developer")).toContain("the plan you ask the owner to approve comes from them.");
});
