import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { formatMemoryMetrics, memoryMetrics } from "../src/observability/memory-metrics";
import { errText } from "../src/observability/redact";
import { readAppLogLines } from "../src/observability/skills-metrics";
import { missingMemoryTables } from "../src/storage/memory-metrics-store";

/**
 * CLI: `bun run metrics:memory [--days N]` (default 7). Opens the db READ-ONLY and reads the app log
 * (<AGENT_HOME>/logs/app.*.jsonl) READ-ONLY; prints per channel and day the memory counts (never note text).
 * Exit codes: 0 ok, 1 read error, 2 bad arguments.
 */
const USAGE = "usage: metrics:memory [--days N]";

function main(argv: string[]): number {
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = Number(argv[++i]);
      if (!Number.isInteger(days) || days < 1) return fail(`bad --days\n${USAGE}`, 2);
    } else return fail(`unknown argument ${argv[i]}\n${USAGE}`, 2);
  }
  const paths = workspacePaths(loadConfig().agentHome);
  const db = new Database(paths.dbFile, { readonly: true });
  try {
    // A db older than the memory migrations: one clear line instead of a raw SQLiteError (db stays read-only).
    const missing = missingMemoryTables(db);
    if (missing.length > 0) {
      return fail(`db has no ${missing.join(", ")}: start the bot once to apply migrations`);
    }
    const m = memoryMetrics(db, readAppLogLines(paths.appLog()), days);
    process.stdout.write(`${formatMemoryMetrics(m, days)}\n`);
    return 0;
  } finally {
    db.close();
  }
}

/** Print an error to stderr and return the exit code. */
function fail(msg: string, code = 1): number {
  process.stderr.write(`metrics:memory: ${msg}\n`);
  return code;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.exit(fail(errText(err)));
}
