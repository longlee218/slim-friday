import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSensitive, isSensitivePath } from "../../src/floor/sensitive-files";

test("an env template holds no secret, so it is not sensitive", () => {
  for (const name of [".env.example", ".env.sample", ".env.template", "app/.ENV.Example"])
    expect(isSensitivePath(name)).toBe(false);
});

test("a real env file stays sensitive", () => {
  for (const name of [".env", ".env.local", ".env.production", "app/.env.reelme"])
    expect(isSensitivePath(name)).toBe(true);
});

test("the scan of a granted dir leaves env templates out", () => {
  const root = mkdtempSync(join(tmpdir(), "friday-sensitive-"));
  for (const name of [".env", ".env.example"]) writeFileSync(join(root, name), "");
  expect(findSensitive(root)).toEqual([join(root, ".env")]);
});
