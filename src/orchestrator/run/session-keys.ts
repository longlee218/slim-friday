/*
 * Session keys: the stable name of "who owns this conversation with the model". Pure builders, no state.
 * - teammate:   one per Discord thread (the teammate / foreground session of that thread).
 * - task:   one per (owned task, role): a worker session never mixes with another task or role.
 */

/** Key of the thread's teammate session. */
export const teammateSessionKey = (threadId: string): string => `teammate:discord:${threadId}`;

/** Key of a worker's session: one task, one role. */
export const taskSessionKey = (taskId: string, role: string): string => `task:${taskId}:${role}`;

/** Key of a role run: the task's worker key when the run is linked to an owned task, else the thread's teammate key. */
export const sessionKeyOf = (r: { threadId: string; role: string; taskId?: string }): string =>
  r.taskId ? taskSessionKey(r.taskId, r.role) : teammateSessionKey(r.threadId);
