import type { RunStepDto } from "@friday/contracts";
import type { LiveRun } from "../../events/client-keys";
import { formatDuration } from "../../lib/format";

/** Lucide icon name of a step; an edit (a tool that carries line counts) gets `file-pen`. */
export function stepIcon(step: RunStepDto): string {
  switch (step.kind) {
    case "skill":
      return "sparkles";
    case "mcp":
      return "plug";
    case "subagent":
      return "bot";
    case "command":
      return "terminal";
    case "writing":
      return "pen-line";
    case "thinking":
      return "sparkle";
    default:
      return step.added !== undefined || step.removed !== undefined ? "file-pen" : "wrench";
  }
}

/** Lines added and removed, or null when the step carries neither count. */
export function stepDelta(step: RunStepDto): { added: number; removed: number } | null {
  if (step.added === undefined && step.removed === undefined) return null;
  return { added: step.added ?? 0, removed: step.removed ?? 0 };
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
