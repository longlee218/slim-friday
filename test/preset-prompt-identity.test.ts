import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRole, ROLES } from "../src/roles/role-registry";

/* Every role (data and rendered prompt sections) equals the golden captured before the roles moved to preset files. */

const DIR = join(import.meta.dir, "fixtures", "preset-golden");
const names = readdirSync(DIR).map((f) => f.replace(/\.json$/, ""));

test("the registry holds exactly the golden roles", () => {
  expect(Object.keys(ROLES).sort()).toEqual(names.sort());
});

for (const name of names) {
  test(`role ${name}: data and prompt equal the golden`, () => {
    const { promptSections, ...data } = getRole(name);
    const golden = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
    // JSON round trip drops `undefined` fields the same way the dump did.
    expect(JSON.parse(JSON.stringify({ ...data, prompt: promptSections() }))).toEqual(golden);
  });
}
