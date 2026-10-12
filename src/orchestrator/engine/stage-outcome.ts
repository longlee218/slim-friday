import { GATE_APPROVED_VERDICT, type StageStatus } from "../../storage/stage-store";
import type { FlowResult } from "../turns/turn-result";

/** Stage row status + gate verdict of a finished stage run (`budget` = stopped on its budget, `go +<usd>` resumes). */
export function stageOutcome(
  res: FlowResult,
  o: { approved?: boolean; stopping: boolean },
): { status: StageStatus; verdict?: string } {
  if (o.approved) return { status: "done", verdict: GATE_APPROVED_VERDICT }; // the approval itself aborts the run
  if (res.outcome === "max_budget") return { status: "interrupted", verdict: "budget" };
  if (res.keepSession && res.outcome === "aborted")
    return { status: "interrupted", verdict: "awaiting_answer" };
  if (res.outcome === "aborted") return { status: o.stopping ? "interrupted" : "cancelled" };
  // A resumable failure (Rev 12) keeps its reason as the verdict: the resume question reads it back.
  return { status: res.outcome === "success" ? "done" : "failed", verdict: res.resumable };
}
