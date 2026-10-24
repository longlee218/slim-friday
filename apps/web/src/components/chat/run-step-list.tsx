import type { RunStepDto } from "@friday/contracts";
import { Check, LoaderCircle, X } from "lucide-react";
import { stepDelta, visibleSteps } from "./run-steps";

/** The state glyph that leads a step (prototype `stepHTML`): spinner, check or x. */
function StateIcon({ state }: { state: RunStepDto["state"] }) {
  if (state === "running") return <LoaderCircle className="spin" />;
  return state === "failed" ? <X /> : <Check />;
}

/** The `<ul class="run-steps">` shared by the live block and the worked disclosure. */
export function RunStepList({ steps }: { steps: RunStepDto[] }) {
  return (
    <ul className="run-steps">
      {visibleSteps(steps).map((s) => {
        const delta = stepDelta(s);
        const cls = s.state === "running" ? "active" : s.state === "failed" ? "failed" : "done";
        return (
          <li key={s.id} className={cls} data-state={s.state}>
            <StateIcon state={s.state} />
            <span>{s.label}</span>
            {s.target && <span className="mono">{s.target}</span>}
            {delta && (
              <span className="delta">
                {delta.added !== undefined && <span className="add">{`+${delta.added}`}</span>}
                {delta.added !== undefined && delta.removed !== undefined && " "}
                {delta.removed !== undefined && <span className="del">{`−${delta.removed}`}</span>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
