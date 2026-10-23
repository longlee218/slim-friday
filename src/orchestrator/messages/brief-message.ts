import type { Database } from "bun:sqlite";
import { PLAN_SECTION_PUSH_CHARS } from "../../config/message-caps";
import {
  TASK_BOARD_ACTION_GET,
  TASK_BOARD_DOC_PLAN,
  TASK_BOARD_DOC_SPEC,
  taskBoardRef,
} from "../../mcp/orchestration/tools/TaskBoardTool/action-names";
import { clip, redactText } from "../../observability/redact";
import type { ItemRow } from "../../storage/owned-item-store";
import { lastMessageOf } from "../../storage/task-message-store";
import { newestApprovedVersion } from "../../storage/work-plan-store";
import { docOfRow } from "../plan/plan-doc";
import { planSection } from "../plan/plan-section";
import { AUTHOR_LEAD } from "./message-kinds";
import { postItemMessage } from "./task-messages";

/**
 * The brief as the worker reads it: the item's brief, then (for an item of an approved plan with spec/plan text) the
 * section of the plan its heading names, and a pointer to the whole spec and plan. Plan text is data.
 */
export function briefText(db: Database, item: ItemRow): string {
  const brief = item.brief ?? "";
  const goalId = item.parentId;
  const version = goalId ? newestApprovedVersion(db, goalId) : undefined;
  if (!goalId || !version || (!version.specMd && !version.planMd)) return brief;
  const section = docOfRow(version).items.find((i) => i.key === item.itemKey)?.section;
  const text = section ? planSection(version.planMd, section) : undefined;
  return [
    brief,
    ...(text !== undefined
      ? [`\nPlan section "${section}" (data):\n${clip(text, PLAN_SECTION_PUSH_CHARS)}`]
      : []),
    `\nSpec and plan of this goal: ${taskBoardRef(TASK_BOARD_ACTION_GET)} {task: "${goalId}", doc: "${TASK_BOARD_DOC_SPEC}"|"${TASK_BOARD_DOC_PLAN}"}`,
  ].join("\n");
}

/**
 * Make sure the item's thread starts with its current brief. Called at every start: the first start writes the brief,
 * a later start (retry, resume, `update`) writes a new one only when the text differs from the newest brief message.
 * Returns the id of the message written, or undefined when nothing was needed.
 */
export function ensureBriefMessage(db: Database, item: ItemRow): number | undefined {
  const text = briefText(db, item).trim();
  if (!text) return undefined;
  // The stored text is redacted: compare in that form so a brief with a secret is not re-written at every start.
  if (lastMessageOf(db, item.id, "brief")?.text === redactText(text)) return undefined;
  return postItemMessage(db, item.id, AUTHOR_LEAD, "brief", text);
}
