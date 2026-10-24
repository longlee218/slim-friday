import { logEvent, logger } from "../observability/logger";
import { startHomeRetention } from "./home-retention-sweeper";
import { startTrashSweeper } from "./trash-sweeper";

const log = logger.child({ module: "boot" });

/** What the process needs to run: the home directory and the signal that ends it. */
export interface BootOptions {
  agentHome: string;
  /** Abort = shut down: sweepers stop, the returned promise resolves. */
  signal: AbortSignal;
  /** The bot engine; it resolves after `signal` aborts and it has shut itself down. Without it nothing answers. */
  startEngine?: (signal: AbortSignal) => Promise<void>;
  /** Called once everything is up (tests wait on it). */
  onReady?: () => void;
}

/**
 * Start the sweepers (home retention, trash) and run the bot engine (`startEngine`) or, when none is given, only
 * wait for `signal`. The old `data/agent.db` is never opened.
 */
export async function bootFriday(opts: BootOptions): Promise<void> {
  const { agentHome, signal } = opts;
  const stops = [
    startTrashSweeper(agentHome), // boot sweep + every 6h: trash entries past 7 days go
    startHomeRetention(agentHome), // boot sweep + every 6h: old app logs and inbox files go
  ];
  opts.onReady?.();
  try {
    if (opts.startEngine) await opts.startEngine(signal);
    else {
      logEvent(log, "engine.absent", { reason: "no engine given", agentHome });
      // A pending promise does not keep Bun's event loop alive and the sweeper timers are unref'd:
      // a ref'd timer holds the process up until the signal aborts.
      const keepAlive = setInterval(() => {}, 2 ** 30);
      if (!signal.aborted)
        await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      clearInterval(keepAlive);
    }
  } finally {
    // Each step is isolated so one failure cannot skip the others.
    for (const stop of stops) {
      try {
        stop();
      } catch (err) {
        log.warn({ err: String(err) }, "sweeper stop failed");
      }
    }
  }
}
