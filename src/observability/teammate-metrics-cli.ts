import { Database } from "bun:sqlite";
import { loadConfig } from "../config/agent-config";
import { workspacePaths } from "../config/workspace-paths";
import { errText } from "./redact";
import { formatTeammateMetrics, teammateMetrics } from "./teammate-metrics";

/**
 * CLI: `bun run metrics:teammate [--days N]` (default 7). Opens the db READ-ONLY and prints the teammate metrics to stdout.
 * Exit codes: 0 ok, 1 read error, 2 bad arguments.
 */
const USAGE = "usage: metrics:teammate [--days N]";

function main(argv: string[]): number {
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = Number(argv[++i]);
      if (!Number.isInteger(days) || days < 1) return fail(`bad --days\n${USAGE}`, 2);
    } else return fail(`unknown argument ${argv[i]}\n${USAGE}`, 2);
  }
  const db = new Database(workspacePaths(loadConfig().agentHome).dbFile, { readonly: true });
  try {
    process.stdout.write(`${formatTeammateMetrics(teammateMetrics(db, days), days)}\n`);
    return 0;
  } finally {
    db.close();
  }
}

/** Print an error to stderr and return the exit code. */
function fail(msg: string, code = 1): number {
  process.stderr.write(`metrics:teammate: ${msg}\n`);
  return code;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.exit(fail(errText(err)));
}
