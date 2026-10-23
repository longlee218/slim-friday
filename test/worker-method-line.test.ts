import { expect, test } from "bun:test";
import { ROLES } from "../src/roles/role-registry";

/** The sections of a role's contract as a run sends them. */
/** The process skill every working role preloads. */
const METHOD_SKILL = "using-skills";

const contract = (name: string) => ROLES[name]?.promptSections().join("\n") ?? "";

/** The part of the Method line every worker contract shares; no skill name in it. */
const METHOD = "- Method: the skills listed for this run are how you work. Before you ";
const CALL = "call the Skill tool for every listed skill whose description matches the request";

/** Roles whose Method rule is in the preloaded method skill: the contract no longer inlines the line. */
const preloads = (name: string) => !!ROLES[name]?.preloadSkills?.includes(METHOD_SKILL);

test("a role without a preloaded skill (not the teammate) has the Method line, once, naming no skill; a preloading role has none", () => {
  for (const name of Object.keys(ROLES).filter((n) => n !== "chief-of-staff")) {
    const c = contract(name);
    if (preloads(name)) {
      expect(c, name).not.toContain("- Method:");
      continue;
    }
    expect(c.split("- Method:"), name).toHaveLength(2);
    expect(c, name).toContain(METHOD);
    expect(c, name).toContain(CALL);
  }
});

test("the roles that keep the line are exactly researcher and scout", () => {
  const keep = Object.keys(ROLES).filter((n) => n !== "chief-of-staff" && !preloads(n));
  expect(keep.sort()).toEqual(["researcher", "scout"]);
});
