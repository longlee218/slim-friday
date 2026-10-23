import { createActionTool } from "../../../action-tool/create-action-tool";
import { TASK_BOARD_TOOL } from "./constants";
import { TASK_BOARD_INTRO } from "./prompt";
import { TASK_BOARD_ACTIONS } from "./task-board-actions";
import type { TaskBoardCtx } from "./task-board-ctx";

/** The `TaskBoard` tool: a thin dispatcher from `{ action, params }` to the reads of the run's thread. */
export const createTaskBoardTool = (ctx: TaskBoardCtx) =>
  createActionTool({
    name: TASK_BOARD_TOOL,
    intro: TASK_BOARD_INTRO,
    ctx,
    actions: TASK_BOARD_ACTIONS,
  });
