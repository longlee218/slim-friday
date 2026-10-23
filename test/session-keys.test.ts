import { expect, test } from "bun:test";
import {
  sessionKeyOf,
  taskSessionKey,
  teammateSessionKey,
} from "../src/orchestrator/run/session-keys";

test("builders: teammate per thread, task per (task, role)", () => {
  expect(teammateSessionKey("123")).toBe("teammate:discord:123");
  expect(taskSessionKey("t1", "developer")).toBe("task:t1:developer");
});

test("sessionKeyOf: a linked run gets the worker key, others the teammate key", () => {
  expect(sessionKeyOf({ threadId: "th", role: "developer", taskId: "t1" })).toBe(
    "task:t1:developer",
  );
  expect(sessionKeyOf({ threadId: "th", role: "assistant" })).toBe("teammate:discord:th");
});
