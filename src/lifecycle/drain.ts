import { existsSync } from "node:fs";
import { join } from "node:path";

/** Reply to a task that arrives while the bot is being deployed. */
export const DRAIN_REPLY = "deploying, retry in a minute";

/** Name of the marker file in AGENT_HOME that puts the bot in drain mode (`touch` it, delete it after the deploy). */
export const DRAIN_FILE = "DRAIN";

/**
 * Drain mode: `FRIDAY_DRAIN=1` or a `DRAIN` file in AGENT_HOME. Checked before every new task starts, so a
 * deploy can wait for the running ones without taking new work (`stop` and `cleanup:` still answer).
 */
export function isDraining(agentHome: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FRIDAY_DRAIN === "1" || existsSync(join(agentHome, DRAIN_FILE));
}
