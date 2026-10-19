import { createActionTool } from "../../../action-tool/create-action-tool";
import { REPORT_TOOL } from "./constants";
import { REPORT_INTRO } from "./prompt";
import { REPORT_ACTIONS, type ReportCtx } from "./report-actions";

/** The worker's `Report` tool: a thin dispatcher from `{ action, params }` to progress and result. */
export const createReportTool = (ctx: ReportCtx) =>
  createActionTool({ name: REPORT_TOOL, intro: REPORT_INTRO, ctx, actions: REPORT_ACTIONS });
