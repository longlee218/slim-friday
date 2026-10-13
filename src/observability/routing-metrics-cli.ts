import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/agent-config";
import { errText } from "./redact";
import {
  computeRoutingMetrics,
  formatMetricsTable,
  type LogEvent,
  type RouteLabel,
} from "./routing-metrics";

/**
 * CLI: `bun run metrics:routing [--since <date>] [--labels <file>] [--json]`.
 * Reads `<AGENT_HOME>/logs/app.*.jsonl` (metadata events) and the human labels
 * `<AGENT_HOME>/eval/route-labels.jsonl` (one `{traceId, correctRole, ...}` per line); prints the metrics to stdout.
 * Exit codes: 0 ok, 1 read error, 2 bad arguments.
 */
const USAGE = "usage: metrics:routing [--since <date>] [--labels <file>] [--json]";

/** Parse JSONL text; malformed lines are skipped (a log may end mid-write). */
function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v !== null && typeof v === "object") out.push(v as T);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

function main(argv: string[]): number {
  let since = 0;
  let labelsFile: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--since" && argv[i + 1]) {
      since = Date.parse(argv[++i]!);
      if (Number.isNaN(since)) return fail(`bad --since date\n${USAGE}`, 2);
    } else if (a === "--labels" && argv[i + 1]) labelsFile = argv[++i];
    else return fail(`unknown argument ${a}\n${USAGE}`, 2);
  }
  const { agentHome } = loadConfig();
  const logDir = join(agentHome, "logs");
  const files = existsSync(logDir)
    ? readdirSync(logDir).filter((f) => /^app\..*\.jsonl$/.test(f))
    : [];
  const events = files
    .flatMap((f) => parseJsonl<LogEvent>(readFileSync(join(logDir, f), "utf8")))
    .filter((e) => (e.time ?? 0) >= since);
  const labelPath = labelsFile ?? join(agentHome, "eval", "route-labels.jsonl");
  const labels = existsSync(labelPath)
    ? parseJsonl<RouteLabel>(readFileSync(labelPath, "utf8"))
    : [];
  const metrics = computeRoutingMetrics(events, labels);
  process.stdout.write(
    `${json ? JSON.stringify(metrics, null, 2) : formatMetricsTable(metrics)}\n`,
  );
  return 0;
}

/** Print an error to stderr and return the exit code. */
function fail(msg: string, code = 1): number {
  process.stderr.write(`metrics:routing: ${msg}\n`);
  return code;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.exit(fail(errText(err)));
}
