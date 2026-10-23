import { bootFriday } from "./lifecycle/boot";
import { loadBootState } from "./lifecycle/boot-checks";
import { logEvent, logger } from "./observability/logger";
import { errText } from "./observability/redact";

const log = logger.child({ module: "index" });

/** Log a fatal startup error (names only, never values) and exit. */
function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

/** Boot: config checks, infrastructure, graceful shutdown on SIGINT / SIGTERM. */
async function main(): Promise<void> {
  let agentHome: string;
  try {
    agentHome = loadBootState().config.agentHome;
  } catch (err) {
    return fail(errText(err));
  }
  const ac = new AbortController();
  let crashed = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logEvent(log, "app.shutdown", { reason: sig });
      ac.abort();
    });
  }
  // Stray errors: log (redacted) and shut down cleanly instead of dying mid-write.
  for (const ev of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(ev, (e) => {
      log.error({ err: errText(e) }, ev);
      crashed = true;
      ac.abort();
    });
  }
  try {
    await bootFriday({ agentHome, signal: ac.signal });
  } catch (err) {
    return fail(errText(err));
  }
  process.exit(crashed ? 1 : 0);
}

void main();
