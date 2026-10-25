import { LoaderCircle, PenLine, Sparkle } from "lucide-react";
import type { LiveRun } from "../../events/client-keys";
import { formatDuration } from "../../lib/format";
import { RunStepList } from "./run-step-list";
import { runPhase } from "./run-steps";
import { useNow } from "./use-now";

const LABEL = { thinking: "Thinking", doing: "Working", writing: "Writing" } as const;

/** A bot's turn in progress: phase header with elapsed time, the steps so far, the subagent tail. */
export function RunBlock({ run, now }: { run: LiveRun; now?: number }) {
  const clock = useNow(now);
  const phase = runPhase(run);
  const Icon = phase === "thinking" ? Sparkle : phase === "writing" ? PenLine : LoaderCircle;
  return (
    <div className="run" data-state={phase}>
      <div className="run-h">
        <Icon className={phase === "doing" ? "spin" : undefined} />
        <span className="run-label">{LABEL[phase]}</span>
        {/* Typing dots only while the reply is written (prototype: "Writing" + dots). */}
        {phase === "writing" && (
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="run-time num">{formatDuration(clock - run.startedAt)}</span>
      </div>
      <RunStepList steps={run.steps} />
      {run.tail && <div className="tail">{run.tail}</div>}
    </div>
  );
}
