import { createActionTool } from "../../../action-tool/create-action-tool";
import { ORCHESTRATE_ACTION_SET_TITLE } from "./action-names";
import { ORCHESTRATE_TOOL } from "./constants";
import { ORCHESTRATE_ACTIONS } from "./orchestrate-actions";
import type { OrchestrateCtx } from "./orchestrate-ctx";
import { ORCHESTRATE_INTRO } from "./prompt";

/**
 * The teammate's `Orchestrate` tool: a thin dispatcher from `{ action, params }` to the teammate handlers. A run without a
 * thread rename port (chat) does not get `set_title` in the table, so the model never sees it.
 */
export const createOrchestrateTool = (ctx: OrchestrateCtx) =>
  createActionTool({
    name: ORCHESTRATE_TOOL,
    intro: ORCHESTRATE_INTRO,
    ctx,
    actions: ORCHESTRATE_ACTIONS.filter(
      (a) => a.name !== ORCHESTRATE_ACTION_SET_TITLE || ctx.memory?.threadTitle,
    ),
  });
