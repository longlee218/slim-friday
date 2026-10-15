import { expect, test } from "bun:test";
import {
  RESULT_KINDS,
  STATUS_OF_RESULT,
  settleResult,
} from "../src/orchestrator/strategy/typed-result";

const F = { success: true, evidence: true, pendingAsk: false };

test("every result kind maps to a task status", () => {
  expect(RESULT_KINDS.map((k) => STATUS_OF_RESULT[k])).toEqual([
    "completed",
    "failed",
    "blocked",
    "blocked",
    "waiting_user",
  ]);
});

test("a reported kind wins over the run facts", () => {
  expect(settleResult("BLOCKED", { ...F, success: false })).toEqual({
    status: "blocked",
    kind: "BLOCKED",
  });
  expect(settleResult("COMPLETED", { ...F, pendingAsk: true })).toEqual({
    status: "completed",
    kind: "COMPLETED",
  });
});

test("derive when no report: success + evidence, error, pending ask, success without evidence", () => {
  expect(settleResult(undefined, F)).toEqual({ status: "completed", kind: "COMPLETED" });
  expect(settleResult(undefined, { ...F, success: false })).toEqual({
    status: "failed",
    kind: "FAILED",
  });
  expect(settleResult(undefined, { ...F, pendingAsk: true })).toEqual({
    status: "waiting_user",
    kind: "NEEDS_CLARIFICATION",
  });
  expect(settleResult(undefined, { ...F, evidence: false })).toEqual({ status: "waiting_user" });
});
