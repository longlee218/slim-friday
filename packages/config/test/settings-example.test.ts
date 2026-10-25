import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_DEFAULTS } from "@friday/core";
import { DEFAULTS_DIR } from "../src/load-config";
import { parseSettingsFile } from "../src/schemas/settings-file";

const text = readFileSync(join(DEFAULTS_DIR, "settings.example.yaml"), "utf8");

/** The template with every `# ` setting turned on and every `## ` explanation dropped. */
const allOn = text
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("##"))
  .map((l) => l.replace(/^(\s*)# /, "$1"))
  .join("\n");

test("settings.example.yaml parses as shipped and with every setting turned on", () => {
  expect(parseSettingsFile(text).autonomy?.level).toBe("balanced");
  const on = parseSettingsFile(allOn);
  expect(on.memory?.providers?.[0]?.id).toBe("honcho");
  expect(on.projectsDir).toBeDefined();
  expect(on.owner?.timeZone).toBe("Europe/Paris");
  expect(on.permissions?.autoReview).toBe(true);
});

test("settings.example.yaml lists every core limit with its default value", () => {
  expect(parseSettingsFile(allOn).limits).toEqual({ ...CORE_DEFAULTS });
});
