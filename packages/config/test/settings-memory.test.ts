import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS_DIR, loadConfig } from "../src/load-config";
import { parseSettingsFile } from "../src/schemas/settings-file";

test("memory.providers: each entry needs an id; its other keys are the plugin's to check", () => {
  const f = parseSettingsFile(
    "memory:\n  providers:\n    - { id: honcho, baseUrl: http://localhost:8000, workspace: home }\n",
  );
  expect(f.memory?.providers).toEqual([
    { id: "honcho", baseUrl: "http://localhost:8000", workspace: "home" },
  ]);
  expect(() => parseSettingsFile("memory:\n  providers:\n    - { baseUrl: x }\n")).toThrow();
  expect(() => parseSettingsFile("memory:\n  other: 1\n")).toThrow();
});

test("the snapshot carries the providers of the last settings file that names them; none by default", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  expect(loadConfig({ defaultsDir: DEFAULTS_DIR, userDir }).snapshot.memoryProviders).toEqual([]);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, "settings.yaml"),
    "memory:\n  providers:\n    - { id: honcho, baseUrl: http://localhost:8000 }\n",
  );
  expect(loadConfig({ defaultsDir: DEFAULTS_DIR, userDir }).snapshot.memoryProviders).toEqual([
    { id: "honcho", baseUrl: "http://localhost:8000" },
  ]);
});
