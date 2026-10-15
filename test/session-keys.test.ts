import { expect, test } from "bun:test";
import {
  leadSessionKey,
  sessionKeyOf,
  taskSessionKey,
} from "../src/orchestrator/engine/session-keys";

test("builders: lead per thread, task per (task, role)", () => {
  expect(leadSessionKey("123")).toBe("lead:discord:123");
  expect(taskSessionKey("t1", "dev")).toBe("task:t1:dev");
});

test("sessionKeyOf: a linked run gets the worker key, others the lead key", () => {
  expect(sessionKeyOf({ threadId: "th", role: "dev", taskId: "t1" })).toBe("task:t1:dev");
  expect(sessionKeyOf({ threadId: "th", role: "assistant" })).toBe("lead:discord:th");
});
