import { expect, test } from "bun:test";
import { z } from "zod";
import {
  ASK_OWNER_SHAPE,
  DISPATCH_AGENT_SHAPE,
  FORWARD_RESULT_SHAPE,
  REPORT_RESULT_SHAPE,
} from "../src/orchestrator/lead/lead-schemas";

const ok = (shape: z.ZodRawShape, v: unknown) => z.object(shape).safeParse(v).success;
const A = { key: "main", role: "developer", brief: "b" };
const D = { strategy: "DIRECT", intent: "i", reason: "r", assignments: [A] };

test("DispatchAgent: accepts a minimal request (dependsOn defaults to [])", () => {
  const r = z.object(DISPATCH_AGENT_SHAPE).parse(D);
  expect(r.assignments[0]?.dependsOn).toEqual([]);
});

test("DispatchAgent: rejects bad strategy, empty / too many assignments, bad key, long brief", () => {
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, strategy: "PLAN" })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: [] })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: Array(9).fill(A) })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: [{ ...A, key: "../x" }] })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: [{ ...A, brief: "x".repeat(4001) }] })).toBe(
    false,
  );
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, intent: "" })).toBe(false);
});

test("AskOwner needs 2-4 options; Forward takes only its enums", () => {
  expect(ok(ASK_OWNER_SHAPE, { question: "q", options: ["a"] })).toBe(false);
  expect(ok(ASK_OWNER_SHAPE, { question: "q", options: ["a", "b", "c", "d", "e"] })).toBe(false);
  expect(ok(ASK_OWNER_SHAPE, { question: "q", options: ["a", "b"] })).toBe(true);
  expect(ok(FORWARD_RESULT_SHAPE, { taskId: "t", mode: "raw" })).toBe(false);
});

test("ReportResult: the five statuses only, summary required, requests optional and capped", () => {
  for (const s of ["COMPLETED", "FAILED", "BLOCKED", "NEEDS_PLANNING", "NEEDS_CLARIFICATION"])
    expect(ok(REPORT_RESULT_SHAPE, { status: s, summary: "x" })).toBe(true);
  expect(ok(REPORT_RESULT_SHAPE, { status: "DONE", summary: "x" })).toBe(false);
  expect(ok(REPORT_RESULT_SHAPE, { status: "FAILED", summary: "" })).toBe(false);
  const req = { kind: "question", text: "t" };
  expect(
    ok(REPORT_RESULT_SHAPE, { status: "FAILED", summary: "x", requests: Array(6).fill(req) }),
  ).toBe(false);
  expect(
    ok(REPORT_RESULT_SHAPE, {
      status: "FAILED",
      summary: "x",
      requests: [{ kind: "x", text: "t" }],
    }),
  ).toBe(false);
});
