import type { RunStepDto } from "@friday/contracts";
import { expect, test } from "vitest";
import { runPhase, stepDelta, workedSummary } from "../../src/components/chat/run-steps";
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

test("delta only when a count exists", () => {
  expect(stepDelta(step("tool"))).toBeNull();
  expect(stepDelta({ ...step("tool"), added: 4 })).toEqual({ added: 4 });
  expect(stepDelta({ ...step("tool"), removed: 2 })).toEqual({ removed: 2 });
});

test("worked summary", () => {
  expect(workedSummary([s(0, 10_000), s(10_000, 42_000), s(42_000, 42_000, "writing")]).text).toBe(
    "Worked for 42s · 2 steps",
  );
  expect(workedSummary([s(0, 5000)]).text).toBe("Worked for 5s · 1 step");
});
