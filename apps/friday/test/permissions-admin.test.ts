import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS_DIR, FileConfig, parseSettingsFile } from "@friday/config";
import { createPermissionsAdmin, withAutoReview } from "../src/permissions-admin";

test("withAutoReview replaces the line, adds it under the block or appends a block; comments stay", () => {
  const block =
    "# mine\nautonomy:\n  level: careful\npermissions:\n  # note\n  autoReview: false\n";
  expect(withAutoReview(block, true)).toBe(block.replace("autoReview: false", "autoReview: true"));
  const head = "permissions:\nlimits:\n  maxHops: 3\n";
  expect(parseSettingsFile(withAutoReview(head, true)).permissions?.autoReview).toBe(true);
  expect(withAutoReview("# only a comment", true)).toBe(
    "# only a comment\npermissions:\n  autoReview: true\n",
  );
  expect(withAutoReview("", false)).toBe("permissions:\n  autoReview: false\n");
  expect(() => withAutoReview("permissions: {autoReview: true}\n", false)).toThrow("by hand");
});

test("the admin writes the owner's settings.yaml, a reload shows it, a symlink is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "perm-"));
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "settings.yaml"), "# keep me\nautonomy:\n  level: careful\n");
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: configDir });
  const admin = createPermissionsAdmin(config, home);
  expect(admin.get()).toEqual({ autoReview: false });
  admin.setAutoReview(true);
  expect(readFileSync(join(configDir, "settings.yaml"), "utf8")).toContain("# keep me");
  config.reload();
  expect(admin.get()).toEqual({ autoReview: true });
  expect(config.settings().level).toBe("careful");
  rmSync(join(configDir, "settings.yaml"));
  symlinkSync(join(home, "elsewhere.yaml"), join(configDir, "settings.yaml"));
  expect(() => admin.setAutoReview(false)).toThrow("symlink");
  rmSync(home, { recursive: true, force: true });
});
