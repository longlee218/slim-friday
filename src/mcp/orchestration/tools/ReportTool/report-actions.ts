import { z } from "zod";
import { refuse } from "../../../../effects/reply";
import { logEvent, logger } from "../../../../observability/logger";
import { REPORT_BLOCKER_SHAPE } from "../../../../orchestrator/teammate/task-schemas";
import {
  REPORT_PROGRESS_SHAPE,
  REPORT_RESULT_SHAPE,
} from "../../../../orchestrator/teammate/teammate-schemas";
import {
  checkReportFiles,
  type ReportFilesCtx,
} from "../../../../orchestrator/worker/report-files";
import { checkReportImages } from "../../../../orchestrator/worker/report-images";
import type { ReportSink } from "../../../../orchestrator/worker/report-sink";
import { defineAction } from "../../../action-tool/action-types";
import { ACTION_UNAVAILABLE } from "../../../action-tool/constants";
import {
  REPORT_ACTION_BLOCKER,
  REPORT_ACTION_PROGRESS,
  REPORT_ACTION_RESULT,
} from "./action-names";

const log = logger.child({ module: "report-tool" });

/** What a worker's report actions need; a part the run lacks makes its action refuse with `ACTION_UNAVAILABLE`. */
export interface ReportCtx {
  /** The run's progress port (bound to its task). */
  progress?: (p: { percent: number; note: string }) => void;
  /** The run's message port (bound to its task): stores a message, returns its ref. */
  message?: (kind: "blocker", text: string) => string;
  /** Where the typed result lands. */
  sink?: ReportSink;
  /** Where the result's `files` are checked and scratch ones copied (home, copy dir, granted location); absent = the run has none. */
  files?: Omit<ReportFilesCtx, "scratchDir">;
  /** The run's scratch dir: where a report's screenshots and (without a location) files may be. */
  scratchDir?: string;
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
      // Everything is checked before anything is kept: a refusal leaves no copy and no sink state, so the worker can
      // report again. Images first (they copy nothing); a refused files check removes its own copies.
      let images: ReportSink["images"];
      if (args.images?.length) {
        const r = checkReportImages(args.images, c.scratchDir);
        if ("errors" in r) return refuse("INVALID_IMAGES", r.errors.join("; "));
        images = r.images;
      }
      if (args.files?.length) {
        if (!c.files) return refuse("INVALID_FILES", "This run has nowhere to read files from.");
        const r = checkReportFiles(args.files, { ...c.files, scratchDir: c.scratchDir });
        if ("errors" in r) return refuse("INVALID_FILES", r.errors.join("; "));
        sink.files = r.files;
      }
      if (images) sink.images = images;
      sink.report = args;
      logEvent(log, "worker.report", {
        status: args.status,
        requests: args.requests?.length ?? 0,
        files: sink.files?.length ?? 0,
        images: sink.images?.length ?? 0,
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
      if (sink.report) return refuse("ALREADY_REPORTED", "You already reported.");
      // A blocker IS a BLOCKED report: the task is held for the teammate, the session is kept for the resume. The sink also
      // carries what it needs, so the end event tells the teammate and the teammate is woken at once.
      sink.report = { title: `Blocked: needs ${p.needs}`, status: "BLOCKED", summary: p.reason };
      sink.blocker = {
        ...p,
        // The full blocker is a message of the task; the end event points to it.
        messageId: c.message?.("blocker", `needs: ${p.needs}. ${p.reason}`),
      };
      logEvent(log, "worker.blocker", { needs: p.needs });
      return { ok: true, note: "Blocker recorded. End your turn now: the teammate decides." };
    },
  }),
];
