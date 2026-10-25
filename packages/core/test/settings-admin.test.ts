import { expect, test } from "bun:test";
import {
  AdminError,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_PX,
  OWNER_FILE_MAX_CHARS,
  RULE_MAX_CHARS,
  RULES_MAX,
} from "../src";

test("AdminError keeps code and field", () => {
  const e = new AdminError("BAD_REQUEST", "name is required.", "name");
  expect([e.code, e.field, e.message]).toEqual(["BAD_REQUEST", "name", "name is required."]);
  expect(e instanceof Error).toBe(true);
});

test("the limits match the contract's", () => {
  // Same values as packages/contracts/src/limits.ts (core must not import contracts).
  expect([RULES_MAX, RULE_MAX_CHARS, OWNER_FILE_MAX_CHARS, AVATAR_MAX_BYTES]).toEqual([
    50,
    500,
    20_000,
    2 * 1024 * 1024,
  ]);
  expect(AVATAR_MAX_PX).toBe(512);
});
