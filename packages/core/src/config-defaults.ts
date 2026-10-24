/** Default limits of the engine; the application config may override them. */
export const CORE_DEFAULTS = {
  /** Longest chain of bot-to-bot hand-offs after one user message. */
  maxHops: 8,
  maxBotMessagesPerConversationPerHour: 60,
  /** The same sender, target and text inside this window counts as a repeat. */
  repeatWindowMs: 600_000,
  maxSpendPerBotPerDayUsd: 10,
  /** An unanswered approval card is a deny after this long. */
  approvalTimeoutMs: 600_000,
  /** A session with no traffic for this long is closed (and resumed on the next message). */
  idleCloseMs: 1_800_000,
  /** Group messages given to a woken bot as context. */
  groupContextMessages: 20,
  /** A queued wake older than this when the app starts is not delivered (it is marked expired). */
  wakeExpireMs: 86_400_000,
  /** Finished wake rows are kept this long. */
  finishedWakeKeepMs: 259_200_000,
  /** Most recalled notes added to a turn. */
  recallNotes: 5,
  /** Most characters of recalled notes added to a turn. */
  recallChars: 2000,
} as const;

export type CoreLimits = typeof CORE_DEFAULTS;
