import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAvatar } from "../src/avatars";

test("the owner's avatar wins over the shipped one; unknown or missing names give none", () => {
  const a = mkdtempSync(join(tmpdir(), "av-a-"));
  const b = mkdtempSync(join(tmpdir(), "av-b-"));
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "dev.png"), "x");
  writeFileSync(join(b, "dev.png"), "y");
  writeFileSync(join(b, "ann.png"), "y");
  expect(resolveAvatar("dev", [a, b])).toBe(join(a, "dev.png"));
  expect(resolveAvatar("ann", [a, b])).toBe(join(b, "ann.png"));
  expect(resolveAvatar("nope", [a, b])).toBeUndefined();
  expect(resolveAvatar(undefined, [a, b])).toBeUndefined();
});
