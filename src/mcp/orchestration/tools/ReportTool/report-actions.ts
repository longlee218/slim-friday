import { z } from "zod";
import type { ArtifactToolCtx } from "../../../../artifacts/artifact-access";
import { resolveRefs } from "../../../../artifacts/artifact-refs";
import { logEvent, logger } from "../../../../observability/logger";
import {
  REPORT_PROGRESS_SHAPE,
  REPORT_RESULT_SHAPE,
} from "../../../../orchestrator/lead/lead-schemas";
import { REPORT_BLOCKER_SHAPE } from "../../../../orchestrator/lead/task-schemas";
import { refuse } from "../../../../orchestrator/reply";
import type { ReportSink } from "../../../../orchestrator/worker/report-sink";
import { defineAction } from "../../../action-tool/action-types";
import { ACTION_UNAVAILABLE } from "../../../action-tool/constants";
import {
  REPORT_ACTION_BLOCKER,
  REPORT_ACTION_PROGRESS,
  REPORT_ACTION_RESULT,
} from "./action-names";
import { REPORT_TOOL } from "./constants";

const log = logger.child({ module: "report-tool" });

/** Refusal code: the run's role has no blocker action. */
const NO_BLOCKER = "NO_BLOCKER";

/** What a worker's report actions need; a part the run lacks makes its action refuse with `ACTION_UNAVAILABLE`. */
export interface ReportCtx {
  /** The run's progress port (bound to its task). */
  progress?: (p: { percent: number; note: string }) => void;
  /** Where the typed result lands. */
  sink?: ReportSink;
  /** Channel scope for the artifact refs of the result. */
  artifacts?: ArtifactToolCtx;
}

/** Every action of the worker's `Report` tool. */
export const REPORT_ACTIONS = [
  defineAction<ReportCtx, typeof REPORT_PROGRESS_SHAPE>({
    name: REPORT_ACTION_PROGRESS,
    schema: z.object(REPORT_PROGRESS_SHAPE),
    example: { percent: 50, note: "tests written" },
    run: (c, p) => {
      if (!c.progress) return refuse(ACTION_UNAVAILABLE, "This run has no progress port.");
      c.progress(p);
      return { ok: true };
    },
  }),
  defineAction<ReportCtx, typeof REPORT_RESULT_SHAPE>({
    name: REPORT_ACTION_RESULT,
    schema: z.object(REPORT_RESULT_SHAPE),
    example: { title: "Short title", status: "COMPLETED", summary: "what was done, with evidence" },
    run: (c, args) => {
      const sink = c.sink;
      if (!sink) return refuse(ACTION_UNAVAILABLE, "This run has no report sink.");
      if (sink.report) return refuse("ALREADY_REPORTED", "You already reported.");
      // The refs are checked first: a bad one is refused here (the report is not stored) so the worker can fix it.
      if (args.artifacts?.length) {
        if (!c.artifacts) return refuse("INVALID_ARTIFACTS", "This run has no artifacts.");
        const r = resolveRefs(c.artifacts, args.artifacts);
        if ("errors" in r) return refuse("INVALID_ARTIFACTS", r.errors.join("; "));
        sink.artifactIds = r.ids;
      }
      sink.report = args;
      logEvent(log, "worker.report", {
        status: args.status,
        requests: args.requests?.length ?? 0,
        artifacts: sink.artifactIds?.length ?? 0,
      });
      return { ok: true };
    },
  }),
  defineAction<ReportCtx, typeof REPORT_BLOCKER_SHAPE>({
    name: REPORT_ACTION_BLOCKER,
    schema: z.object(REPORT_BLOCKER_SHAPE),
    example: { reason: "Needs the staging API key to run the tests", needs: "access" },
    run: (c, p) => {
      const sink = c.sink;
      if (!sink) return refuse(ACTION_UNAVAILABLE, "This run has no report sink.");
      if (sink.noBlocker)
        return refuse(
          NO_BLOCKER,
          `A planner has no blocker: end with ${REPORT_TOOL} ${REPORT_ACTION_RESULT} (status BLOCKED or NEEDS_CLARIFICATION).`,
        );
      if (sink.report) return refuse("ALREADY_REPORTED", "You already reported.");
      // A blocker IS a BLOCKED report: the task is held for the lead, the session is kept for the resume. The sink also
      // carries what it needs, so the end event tells the lead and the lead is woken at once.
      sink.report = { title: `Blocked: needs ${p.needs}`, status: "BLOCKED", summary: p.reason };
      sink.blocker = p;
      logEvent(log, "worker.blocker", { needs: p.needs });
      return { ok: true, note: "Blocker recorded. End your turn now: the lead decides." };
    },
  }),
];
