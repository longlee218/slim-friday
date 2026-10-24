import type { RunStepDto } from "@friday/contracts";
import { ChevronRight } from "lucide-react";
import { RunStepList } from "./run-step-list";
import { workedSummary } from "./run-steps";

/** "Worked for 42s · 3 steps" under a finished bot message; opens to the steps, all done. */
export function WorkedDisclosure({ steps }: { steps: RunStepDto[] }) {
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
