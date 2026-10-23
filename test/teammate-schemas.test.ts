import { expect, test } from "bun:test";
import { z } from "zod";
import { MAX_ASSIGNMENTS } from "../src/orchestrator/teammate/teammate-limits";
import {
  ASK_OWNER_SHAPE,
  DISPATCH_AGENT_SHAPE,
  FORWARD_RESULT_SHAPE,
  REPORT_RESULT_SHAPE,
} from "../src/orchestrator/teammate/teammate-schemas";

const ok = (shape: z.ZodRawShape, v: unknown) => z.object(shape).safeParse(v).success;
const A = { key: "main", subject: "task", role: "developer", brief: "b" };
const D = { strategy: "DIRECT", small: true, intent: "i", reason: "r", assignments: [A] };

test("Orchestrate dispatch: accepts a minimal request (dependsOn defaults to [])", () => {
  const r = z.object(DISPATCH_AGENT_SHAPE).parse(D);
  expect(r.assignments[0]?.dependsOn).toEqual([]);
});

test("Orchestrate dispatch: rejects bad strategy, empty / too many assignments, bad key, long brief", () => {
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, strategy: "PLAN" })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: [] })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: Array(MAX_ASSIGNMENTS + 1).fill(A) })).toBe(
    false,
  );
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: [{ ...A, key: "../x" }] })).toBe(false);
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, assignments: [{ ...A, brief: "x".repeat(4001) }] })).toBe(
    false,
  );
  expect(ok(DISPATCH_AGENT_SHAPE, { ...D, intent: "" })).toBe(false);
});

test("Orchestrate ask_owner: kind is required and one of yesno/select/text; options capped at 25; Forward takes only its enums", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
  expect(ok(ASK_OWNER_SHAPE, { question: "q", options: ["a", "b"] })).toBe(false); // no kind
  expect(ok(ASK_OWNER_SHAPE, { question: "q", kind: "form" })).toBe(false);
  for (const kind of ["yesno", "text"])
    expect(ok(ASK_OWNER_SHAPE, { question: "q", kind })).toBe(true);
  expect(ok(ASK_OWNER_SHAPE, { question: "q", kind: "select", options: many(25) })).toBe(true);
  expect(ok(ASK_OWNER_SHAPE, { question: "q", kind: "select", options: many(26) })).toBe(false);
  expect(ok(FORWARD_RESULT_SHAPE, { taskId: "t", mode: "raw" })).toBe(false);
});

test("Report result: the five statuses only, summary required, requests optional and capped", () => {
  for (const s of ["COMPLETED", "FAILED", "BLOCKED", "NEEDS_PLANNING", "NEEDS_CLARIFICATION"])
    expect(ok(REPORT_RESULT_SHAPE, { title: "t", status: s, summary: "x" })).toBe(true);
  expect(ok(REPORT_RESULT_SHAPE, { title: "t", status: "DONE", summary: "x" })).toBe(false);
  expect(ok(REPORT_RESULT_SHAPE, { title: "t", status: "FAILED", summary: "" })).toBe(false);
  expect(ok(REPORT_RESULT_SHAPE, { status: "FAILED", summary: "x" })).toBe(false); // title required
  expect(ok(REPORT_RESULT_SHAPE, { title: "x".repeat(5000), status: "FAILED", summary: "x" })).toBe(
    true,
  ); // no cap
  const req = { kind: "question", text: "t" };
  expect(
    ok(REPORT_RESULT_SHAPE, {
      title: "t",
      status: "FAILED",
      summary: "x",
      requests: Array(6).fill(req),
    }),
  ).toBe(false);
  expect(
    ok(REPORT_RESULT_SHAPE, {
      title: "t",
      status: "FAILED",
      summary: "x",
      requests: [{ kind: "x", text: "t" }],
    }),
  ).toBe(false);
});
