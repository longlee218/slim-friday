import { z } from "zod";
import { SEARCH_QUERY_MAX_CHARS } from "../../../../orchestrator/lead/lead-limits";
import { boardMessages, boardRead } from "../../../../orchestrator/messages/task-board-messages";
import {
  boardGet,
  boardList,
  boardSearch,
} from "../../../../orchestrator/messages/task-board-reads";
import { defineAction } from "../../../action-tool/action-types";
import {
  TASK_BOARD_ACTION_GET,
  TASK_BOARD_ACTION_LIST,
  TASK_BOARD_ACTION_MESSAGES,
  TASK_BOARD_ACTION_READ,
  TASK_BOARD_ACTION_SEARCH,
  TASK_BOARD_DOC_PLAN,
  TASK_BOARD_DOC_SPEC,
} from "./action-names";
import type { TaskBoardCtx } from "./task-board-ctx";

/* The `TaskBoard` action table: each row binds a read of `orchestrator/messages` (the rules live there). */

const TASK = z.string().min(1).max(80).describe("Task id or key");
const GOAL_ID = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe("Goal id, when a key is in several goals");
const LIST_SHAPE = {
  taskId: z.string().min(1).max(80).optional().describe("Show the goal of this task or goal id"),
};
const GET_SHAPE = {
  task: TASK,
  goalId: GOAL_ID,
  doc: z
    .enum([TASK_BOARD_DOC_SPEC, TASK_BOARD_DOC_PLAN])
    .optional()
    .describe("With a goal id as task: read the goal's spec or plan text, paged by offset"),
  offset: z.number().int().min(0).optional().describe("Char offset into doc (nextOffset)"),
};
const MESSAGES_SHAPE = {
  task: TASK,
  goalId: GOAL_ID,
  since: z.string().min(1).max(20).optional().describe("Ref of the last message you have (M42)"),
};
const READ_SHAPE = {
  id: z.string().min(1).max(20).describe("Message ref (M42)"),
  offset: z.number().int().min(0).optional().describe("Char offset (nextOffset of the last page)"),
};
const SEARCH_SHAPE = {
  query: z.string().min(1).max(SEARCH_QUERY_MAX_CHARS).describe("Words of the task or message"),
};

/** Every action of the `TaskBoard` tool. */
export const TASK_BOARD_ACTIONS = [
  defineAction<TaskBoardCtx, typeof LIST_SHAPE>({
    name: TASK_BOARD_ACTION_LIST,
    schema: z.object(LIST_SHAPE),
    example: {},
    run: (c, p) => boardList(c.db, c.threadId, p.taskId),
  }),
  defineAction<TaskBoardCtx, typeof GET_SHAPE>({
    name: TASK_BOARD_ACTION_GET,
    schema: z.object(GET_SHAPE),
    example: { task: "main" },
    run: (c, p) => boardGet(c.db, c.threadId, p.task, p.goalId, p.doc, p.offset),
  }),
  defineAction<TaskBoardCtx, typeof MESSAGES_SHAPE>({
    name: TASK_BOARD_ACTION_MESSAGES,
    schema: z.object(MESSAGES_SHAPE),
    example: { task: "main", since: "M42" },
    run: (c, p) => boardMessages(c.db, c.threadId, p.task, p.goalId, p.since),
  }),
  defineAction<TaskBoardCtx, typeof READ_SHAPE>({
    name: TASK_BOARD_ACTION_READ,
    schema: z.object(READ_SHAPE),
    example: { id: "M42" },
    run: (c, p) => boardRead(c.db, c.threadId, p.id, p.offset),
  }),
  defineAction<TaskBoardCtx, typeof SEARCH_SHAPE>({
    name: TASK_BOARD_ACTION_SEARCH,
    schema: z.object(SEARCH_SHAPE),
    example: { query: "login bug" },
    run: (c, p) => boardSearch(c.db, c.threadId, p.query),
  }),
];
