/**
 * State of an owned task (a goal or one of its items). Lives here (was `routing/routing-contracts`)
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

/** Why an owned task changed owner (logged as `task.owner_changed`). */
export type ReasonCode =
  | "OUT_OF_SCOPE"
  | "CONTEXT_CONTINUATION"
  | "EXPLICIT_SWITCH"
  | "MISSING_INFORMATION"
  | "CAPABILITY_UNAVAILABLE"
  | "AUTHORIZATION_REQUIRED"
  | "AMBIGUOUS_INTENT"
  | "ROUTE_CONFLICT";
