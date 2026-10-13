import { logEvent, logger } from "../../observability/logger";

const log = logger.child({ module: "memory-index" });

/** Run `fn`; on a throw log `memory.index.error` (class only, never content) and return undefined. A broken index must not break a run or the bot. */
export function safely<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    logEvent(log, "memory.index.error", { what, err: String(err).slice(0, 200) }, "warn");
    return undefined;
  }
}
