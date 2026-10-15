/**
 * State of an owned task (a goal or one of its items). Moved here from `routing/routing-contracts`
 * (that file re-exports it until the routing layer is removed).
 */
export type TaskState = {
  taskId: string;
  ownerAgentId: string | null;
  /**
   * `open` = a goal / legacy task; `pending` -> `ready` -> `running` are the item states;
   * `blocked` = waits on something other than the owner (e.g. NEEDS_PLANNING).
   */
  status:
    | "open"
    | "pending"
    | "ready"
    | "waiting_user"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  scope: string;
  lastProgressAt: string;
  /** Compare-and-set counter against concurrent updates. */
  version: number;
  correlationId: string;
};
