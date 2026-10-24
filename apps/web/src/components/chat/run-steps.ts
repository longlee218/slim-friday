import type { RunStepDto } from "@friday/contracts";
import type { LiveRun } from "../../events/client-keys";
import { formatDuration } from "../../lib/format";

/** Lines added and removed (only the counts the step carries), or null when it has neither. */
export function stepDelta(step: RunStepDto): { added?: number; removed?: number } | null {
  if (step.added === undefined && step.removed === undefined) return null;
  return {
    ...(step.added !== undefined && { added: step.added }),
    ...(step.removed !== undefined && { removed: step.removed }),
  };
}

/** Phase of a live run: thinking until a real step starts, writing while the last step is writing. */
export function runPhase(run: LiveRun): "thinking" | "doing" | "writing" {
  const { steps } = run;
  if (steps.every((s) => s.kind === "thinking")) return "thinking";
  const last = steps[steps.length - 1];
  return last?.kind === "writing" && last.state === "running" ? "writing" : "doing";
}

/** Steps worth listing: thinking and writing are phases, not steps. */
export const visibleSteps = (steps: RunStepDto[]): RunStepDto[] =>
  steps.filter((s) => s.kind !== "thinking" && s.kind !== "writing");

/** "Worked for 42s · 3 steps": span from first start to last end, counting visible steps. */
export function workedSummary(steps: RunStepDto[]): { ms: number; count: number; text: string } {
  const start = Math.min(...steps.map((s) => s.startedAt));
  const end = Math.max(...steps.map((s) => s.endedAt ?? s.startedAt));
  const ms = steps.length ? end - start : 0;
  const count = visibleSteps(steps).length;
  return {
    ms,
    count,
    text: `Worked for ${formatDuration(ms)} · ${count} ${count === 1 ? "step" : "steps"}`,
  };
}
