// One-off helper: write every role's data and rendered prompt sections to test/fixtures/preset-golden/<name>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES } from "../src/roles/role-registry";

const dir = join(import.meta.dir, "..", "test", "fixtures", "preset-golden");
mkdirSync(dir, { recursive: true });
for (const [name, role] of Object.entries(ROLES)) {
  const { promptSections, ...data } = role;
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify({ ...data, prompt: promptSections() }, null, 2)}\n`,
  );
}
