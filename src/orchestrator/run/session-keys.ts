/*
 * Session keys: the stable name of "who owns this conversation with the model". Pure builders, no state.
 * - lead:   one per Discord thread (the lead / foreground session of that thread).
 * - task:   one per (owned task, role): a worker session never mixes with another task or role.
 */

/** Key of the thread's lead session. */
export const leadSessionKey = (threadId: string): string => `lead:discord:${threadId}`;

/** Key of a worker's session: one task, one role. */
export const taskSessionKey = (taskId: string, role: string): string => `task:${taskId}:${role}`;

/** Key of a role run: the task's worker key when the run is linked to an owned task, else the thread's lead key. */
export const sessionKeyOf = (r: { threadId: string; role: string; taskId?: string }): string =>
  r.taskId ? taskSessionKey(r.taskId, r.role) : leadSessionKey(r.threadId);
