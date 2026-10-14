import { resolve } from "node:path";
import { errText } from "../observability/redact";
import { migrateLocations } from "./migrate-locations";
import { formatReport } from "./migrate-locations-report";

/**
 * CLI: `bun run migrate:locations [--apply]`. Dry-run by default (prints the plan, writes nothing).
 * Reads AGENT_HOME from the environment (.env is loaded by Bun). The bot must be stopped.
 * Exit codes: 0 ok / nothing to do, 1 error, failed workspace or skipped entries, 2 bad arguments.
 */
function main(argv: string[]): number {
  const unknown = argv.filter((a) => a !== "--apply");
  if (unknown.length)
    return fail(`unknown argument ${unknown[0]}\nusage: migrate:locations [--apply]`, 2);
  const envHome = process.env.AGENT_HOME;
  if (!envHome) return fail("AGENT_HOME is not set");
  const home = resolve(envHome); // absolute: rewritten location paths must not be relative
  const report = migrateLocations(home, { apply: argv.includes("--apply") });
  process.stdout.write(`${formatReport(report).join("\n")}\n`);
  return report.failed.length || report.plans.some((p) => p.skipped.length) ? 1 : 0;
}

/** Print an error to stderr and return the exit code. */
function fail(msg: string, code = 1): number {
  process.stderr.write(`migrate:locations: ${msg}\n`);
  return code;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.exit(fail(errText(err)));
}
