import type { RunStepDto } from "@friday/contracts";
import { expect, test } from "vitest";
import { runPhase, stepDelta, stepIcon, workedSummary } from "../../src/components/chat/run-steps";
import type { LiveRun } from "../../src/events/client-keys";
import { step } from "./run-fixtures";

const run = (steps: RunStepDto[], startedAt = 0): LiveRun => ({ botId: "dev", startedAt, steps });
const s = (startedAt: number, endedAt: number, kind: RunStepDto["kind"] = "tool") =>
  step(kind, "done", { startedAt, endedAt });

test("phase", () => {
  expect(runPhase(run([]))).toBe("thinking");
  expect(runPhase(run([step("thinking", "running")]))).toBe("thinking");
  expect(runPhase(run([step("tool", "running")]))).toBe("doing");
  expect(runPhase(run([step("tool", "done"), step("writing", "running")]))).toBe("writing");
});

test("icons by kind", () => {
  expect(stepIcon(step("skill"))).toBe("sparkles");
  expect(stepIcon({ ...step("tool"), added: 42, removed: 3 })).toBe("file-pen");
  expect(stepIcon(step("mcp"))).toBe("plug");
  expect(stepIcon(step("subagent"))).toBe("bot");
  expect(stepIcon(step("command"))).toBe("terminal");
  expect(stepIcon(step("writing"))).toBe("pen-line");
  expect(stepIcon(step("thinking"))).toBe("sparkle");
  expect(stepIcon(step("tool"))).toBe("wrench");
});

test("delta only when a count exists", () => {
  expect(stepDelta(step("tool"))).toBeNull();
  expect(stepDelta({ ...step("tool"), added: 4 })).toEqual({ added: 4, removed: 0 });
});

test("worked summary", () => {
  expect(workedSummary([s(0, 10_000), s(10_000, 42_000), s(42_000, 42_000, "writing")]).text).toBe(
    "Worked for 42s · 2 steps",
  );
  expect(workedSummary([s(0, 5000)]).text).toBe("Worked for 5s · 1 step");
});
