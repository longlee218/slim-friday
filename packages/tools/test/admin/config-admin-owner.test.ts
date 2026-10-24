import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigAdmin } from "@friday/core";
import { createConfigAdmin } from "../../src/admin/config-admin";
import { setup } from "../design-fixture";

let configDir: string;
let defaultsDir: string;
let admin: ConfigAdmin;

beforeEach(() => {
  const s = setup();
  configDir = s.configDir;
  defaultsDir = join(s.base, "defaults");
  mkdirSync(defaultsDir);
  writeFileSync(join(defaultsDir, "SOUL.md"), "Shipped soul.\n");
  admin = createConfigAdmin({ ...s.ctx, defaultsDir });
});

test("refuses text over 20,000 chars and writes nothing", () => {
  expect(() => admin.saveOwnerFile("USER", "x".repeat(20_001))).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST", field: "text" }),
  );
  expect(existsSync(join(configDir, "USER.md"))).toBe(false);
});

test("refuses a write through a symlinked file", () => {
  const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "t.md");
  symlinkSync(outside, join(configDir, "SOUL.md"));
  expect(() => admin.saveOwnerFile("SOUL", "hi")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
  expect(existsSync(outside)).toBe(false);
});

test("SOUL falls back to the shipped text, USER to empty", () => {
  expect(admin.readOwnerFile("SOUL")).toBe("Shipped soul.\n");
  expect(admin.readOwnerFile("USER")).toBe("");
});

test("save then read returns the text", () => {
  admin.saveOwnerFile("USER", "I am Long.");
  expect(admin.readOwnerFile("USER")).toBe("I am Long.");
  expect(readFileSync(join(configDir, "USER.md"), "utf8")).toBe("I am Long.");
  admin.saveOwnerFile("SOUL", "Mine.");
  expect(admin.readOwnerFile("SOUL")).toBe("Mine.");
});
