import { workspacePaths } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import { openDb } from "../storage/db";
import { startHomeRetention } from "./home-retention-sweeper";
import { runStartupHygiene } from "./startup";
import { startTrashSweeper } from "./trash-sweeper";

const log = logger.child({ module: "boot" });

/** What the process needs to run: the home directory and the signal that ends it. */
export interface BootOptions {
  agentHome: string;
  /** Abort = shut down: sweepers stop, the db closes, the returned promise resolves. */
  signal: AbortSignal;
  /** Called once everything is up (tests wait on it). */
  onReady?: () => void;
}

/**
 * Start the infrastructure (db with migrations, startup hygiene, home retention and trash sweepers) and
 * wait for `signal`. The bot engine is being rebuilt (see docs/superpowers/specs/2026-10-23-friday-team-engine-design.md),
 * so nothing answers messages yet.
 */
export async function bootFriday(opts: BootOptions): Promise<void> {
  const { agentHome, signal } = opts;
  // Opening applies the Drizzle migrations; an old-format db is refused, untouched.
  const db = openDb(workspacePaths(agentHome).dbFile);
  await runStartupHygiene(db, agentHome);
  const stops = [
    startTrashSweeper(agentHome), // boot sweep + every 6h: trash entries past 7 days go
    startHomeRetention(agentHome), // boot sweep + every 6h: old task logs, app logs and run dirs go
  ];
  logEvent(log, "engine.absent", { reason: "rebuild in progress", agentHome });
  opts.onReady?.();
  if (!signal.aborted)
    await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
  // Each step is isolated so one failure cannot skip closing the db.
  for (const stop of stops) {
    try {
      stop();
    } catch (err) {
      log.warn({ err: String(err) }, "sweeper stop failed");
    }
  }
  db.close();
}
