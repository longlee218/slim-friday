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
  /** Most characters of a bot's MEMORY.md put in its system prompt (over it, older notes are left to search). */
  memoryPromptChars: 12000,
  /** Most characters of a group's memory put in a group turn. */
  groupMemoryPromptChars: 6000,
  /** Worker processes claiming runs (0 = run in the main process). */
  workers: 2,
  /** Runs one worker executes at the same time. */
  runsPerWorker: 4,
  /** A run lease expires this long after the last heartbeat. */
  leaseMs: 300_000,
  /** How often a worker renews the leases of its runs. */
  heartbeatMs: 60_000,
  /** How often a run checks that it was not cancelled or fenced. */
  fenceCheckMs: 1_000,
  /** Fallback scan for queued runs when no wake signal arrived. */
  scanMs: 5_000,
  /** A run queued longer than this before starting is logged as a warning. */
  queueDelayWarnMs: 30_000,
  /** A stream with no event for this long is cut. */
  streamIdleMs: 180_000,
  /** Retries of a transient failure before giving up. */
  transientRetries: 5,
  /** Setup failures before a run is failed. */
  setupFailures: 8,
  /** Times a run is cut and re-sent before it is failed. */
  cutAttempts: 3,
  /** An unanswered approval card gets one reminder after this long. */
  cardReminderMs: 14_400_000,
  /** How often the outcome reconciler returns finished results not yet returned to their sender. */
  reconcileMs: 30_000,
  /** A worker claims no new run below this much free memory. */
  minFreeMemoryMb: 512,
} as const;

export type CoreLimits = typeof CORE_DEFAULTS;
