/** Send owner text to a running worker (or answer its pending question). */
export const STEER_TASK_TOOL = "SteerTask";

/** Max chars of the text a `SteerTask` call sends to a worker (defined orchestrator-side, re-exported here). */
export { STEER_TEXT_MAX_CHARS } from "../../../../orchestrator/engine/lead-limits";
