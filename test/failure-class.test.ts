import { expect, test } from "bun:test";
import {
  classifyRunFailure,
  type FailureInput,
  isTransientError,
} from "../src/runtime/failure-class";

/* The pure failure classifier: transient (same session resumes), real (held for the teammate), owner stop (cancel). */

const cases: [string, FailureInput, "transient" | "real" | "owner_stop", string][] = [
  [
    "overloaded_error text",
    { outcome: "error", errorText: "API Error: 529 overloaded_error" },
    "transient",
    "api_error",
  ],
  [
    "the stream saw an overload before it blanked the text",
    { outcome: "quota", transient: true },
    "transient",
    "api_error",
  ],
  [
    "5xx",
    { outcome: "error", errorText: "API Error: 503 Service Unavailable" },
    "transient",
    "api_error",
  ],
  [
    "rate limit without a usage window",
    { outcome: "error", errorText: "rate_limit_error: slow down" },
    "transient",
    "api_error",
  ],
  ["ECONNRESET", { outcome: "error", errorText: "read ECONNRESET" }, "transient", "api_error"],
  [
    "ETIMEDOUT",
    { outcome: "error", errorText: "connect ETIMEDOUT 1.2.3.4:443" },
    "transient",
    "api_error",
  ],
  ["socket hang up", { outcome: "error", errorText: "socket hang up" }, "transient", "api_error"],
  [
    "fetch failed",
    { outcome: "error", errorText: "TypeError: fetch failed" },
    "transient",
    "api_error",
  ],
  ["watchdog abort (stale)", { outcome: "aborted", abortCause: "stale" }, "transient", "stale"],
  ["shutdown abort (SIGTERM)", { outcome: "aborted", stopping: true }, "transient", "shutdown"],
  [
    "a failed resume",
    { outcome: "error", errorText: "No conversation found with session ID x" },
    "transient",
    "resume_failed",
  ],
  ["owner /stop", { outcome: "aborted" }, "owner_stop", "owner_stop"],
  ["budget hit", { outcome: "max_budget" }, "real", "max_budget"],
  ["turn limit", { outcome: "max_turns" }, "real", "max_turns"],
  [
    "usage limit (quota, no transient flag)",
    { outcome: "quota", errorText: "usage limit reached" },
    "real",
    "quota",
  ],
  ["unknown error (text blanked)", { outcome: "error", errorText: "" }, "real", "error"],
  ["a plain error", { outcome: "error", errorText: "tests failed: 3 assertions" }, "real", "error"],
  [
    "a line number is not a 5xx",
    { outcome: "error", errorText: "TypeError at app.ts:503:1" },
    "real",
    "error",
  ],
];

test.each(cases)("%s", (_name, input, cls, cause) => {
  expect(classifyRunFailure(input)).toEqual({ class: cls, cause });
});

test("isTransientError: empty and unrelated text are not transient", () => {
  expect(isTransientError(undefined)).toBe(false);
  expect(isTransientError("")).toBe(false);
  expect(isTransientError("credit balance is too low")).toBe(false);
});
