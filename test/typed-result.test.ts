import { expect, test } from "bun:test";
import { RESULT_KINDS, STATUS_OF_RESULT } from "../src/orchestrator/strategy/typed-result";

test("every result kind maps to a task status", () => {
  expect(RESULT_KINDS.map((k) => STATUS_OF_RESULT[k])).toEqual([
    "completed",
    "failed",
    "blocked",
    "blocked",
    "waiting_user",
  ]);
});
