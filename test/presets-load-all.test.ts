import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadPresets } from "../src/presets/preset-loader";

/* Every shipped preset loads, and no prompt names a tool of the removed engine. */

const REPO = join(import.meta.dir, "..", "config", "presets");
const ENGINE_WORDS = [
  "Orchestrate",
  "TaskBoard",
  "MessageTeammate",
  "SaveArtifact",
  "Report blocker",
  "Report result",
  "Report progress",
  "Asking the teammate",
];

test("every shipped preset loads and no prompt mentions an engine tool", () => {
  const roles = loadPresets(REPO);
  expect(Object.keys(roles).length).toBeGreaterThan(0);
  for (const [name, role] of Object.entries(roles)) {
    const text = role.promptSections().join("\n");
    for (const word of ENGINE_WORDS) expect(text, `${name}: ${word}`).not.toContain(word);
  }
});
