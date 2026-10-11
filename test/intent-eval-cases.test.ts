import { expect, test } from "bun:test";
import { dispatchableRoleNames } from "../src/roles/role-registry";
import { GOLDEN } from "./intent-eval-cases";

// Shape of the golden data (no live call).

test("every expected role of the golden set is a registry role", () => {
  const names = dispatchableRoleNames();
  for (const c of GOLDEN) if (c.expect.role) expect(names).toContain(c.expect.role);
});

test("no duplicate case text (a holdout never repeats a tuning case)", () => {
  const texts = GOLDEN.map((c) => c.text);
  expect(new Set(texts).size).toBe(texts.length);
});
