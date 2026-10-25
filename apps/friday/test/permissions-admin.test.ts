import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  // On by default (the shipped settings.yaml), until the owner's file says otherwise.
  expect(admin.get()).toEqual({ autoReview: true });
  admin.setAutoReview(false);
  expect(readFileSync(join(configDir, "settings.yaml"), "utf8")).toContain("# keep me");
  config.reload();
  expect(admin.get()).toEqual({ autoReview: false });
  expect(config.settings().level).toBe("careful");
  rmSync(join(configDir, "settings.yaml"));
  symlinkSync(join(home, "elsewhere.yaml"), join(configDir, "settings.yaml"));
  expect(() => admin.setAutoReview(false)).toThrow("symlink");
  rmSync(home, { recursive: true, force: true });
});

test("a CRLF file stays CRLF and its autoReview line is found", () => {
  const crlf = "autonomy:\r\n  level: careful\r\npermissions: # mine\r\n  autoReview: false\r\n";
  expect(withAutoReview(crlf, true)).toBe(crlf.replace("autoReview: false", "autoReview: true"));
  expect(withAutoReview("autonomy:\r\n  level: careful\r\n", true)).toBe(
    "autonomy:\r\n  level: careful\r\npermissions:\r\n  autoReview: true\r\n",
  );
  const head = withAutoReview("permissions:\r\nlimits:\r\n  maxHops: 3\r\n", true);
  expect(head).toBe("permissions:\r\n  autoReview: true\r\nlimits:\r\n  maxHops: 3\r\n");
  expect(parseSettingsFile(head).permissions?.autoReview).toBe(true);
});

test("a save keeps the file's mode", () => {
  const home = mkdtempSync(join(tmpdir(), "perm-"));
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "settings.yaml");
  writeFileSync(file, "autonomy:\n  level: careful\n");
  chmodSync(file, 0o600);
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir: configDir });
  createPermissionsAdmin(config, home).setAutoReview(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toContain("autoReview: true");
  rmSync(home, { recursive: true, force: true });
});
