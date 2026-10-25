import type { RunStepDto } from "@friday/contracts";
import { ChevronRight } from "lucide-react";
import { RunStepList } from "./run-step-list";
import { visibleSteps, workedSummary } from "./run-steps";

/**
 * "Worked for 42s · 3 steps" under a finished bot message; opens to the steps, all done.
 * The turn is over, so a step stored as `running` shows as done (failed stays failed).
 * Nothing renders when no step is visible (only thinking or writing).
 */
export function WorkedDisclosure({ steps: stored }: { steps: RunStepDto[] }) {
  if (visibleSteps(stored).length === 0) return null;
  const steps = stored.map((s) => (s.state === "running" ? { ...s, state: "done" as const } : s));
  return (
    <details className="worked">
      <summary>
        <ChevronRight className="chev" />
        {workedSummary(steps).text}
      </summary>
      <RunStepList steps={steps} />
    </details>
  );
}
