/** Things shutdown must stop, in order (injectable for tests). */
export interface ShutdownDeps {
  /** Abort active runs and wait (bounded) for them. */
  drain: (timeoutMs: number) => Promise<void>;
  /** Disconnect the Discord client. */
  destroyClient: () => Promise<void>;
  /** Close the database. */
  closeDb: () => void;
  /** Log a line (already redacted by caller). */
  log: (msg: string) => void;
  /** Process exit. */
  exit: (code: number) => void;
  /** Max wait for runs to finish before closing the db. */
  drainTimeoutMs?: number;
}

/** Build an idempotent shutdown: a second call while closing is ignored. */
export function createShutdown(deps: ShutdownDeps) {
  /** Set on first call; guards against double SIGINT / error-then-signal re-entry. */
  let closing = false;
  return async function shutdown(reason: string, code = 0): Promise<void> {
    if (closing) return;
    closing = true;
    deps.log(`shutting down: ${reason}`);
    // Each step is isolated so one failure cannot skip closing the db.
    try {
      await deps.drain(deps.drainTimeoutMs ?? 10_000);
    } catch {
      /* best effort */
    }
    try {
      await deps.destroyClient();
    } catch {
      /* best effort */
    }
    try {
      deps.closeDb();
    } catch {
      /* best effort */
    }
    deps.exit(code);
  };
}
