import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { errText } from "../src/observability/redact";
import {
  formatSkillsMetrics,
  readAppLogLines,
  skillsMetricsFromLines,
} from "../src/observability/skills-metrics";

/**
 * CLI: `bun run metrics:skills [--days N]` (default 7). Reads the `skills.used` lines of the app log
 * (<AGENT_HOME>/logs/app.*.jsonl) READ-ONLY and prints per role: runs, average skills called, skills never called.
 * Exit codes: 0 ok, 1 read error, 2 bad arguments.
 */
const USAGE = "usage: metrics:skills [--days N]";
const DAY_MS = 86_400_000;

function main(argv: string[]): number {
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) {
      days = Number(argv[++i]);
      if (!Number.isInteger(days) || days < 1) return fail(`bad --days\n${USAGE}`, 2);
    } else return fail(`unknown argument ${argv[i]}\n${USAGE}`, 2);
  }
  const base = workspacePaths(loadConfig().agentHome).appLog();
  const stats = skillsMetricsFromLines(readAppLogLines(base), Date.now() - days * DAY_MS);
  process.stdout.write(`${formatSkillsMetrics(stats, days)}\n`);
  return 0;
}

/** Print an error to stderr and return the exit code. */
function fail(msg: string, code = 1): number {
  process.stderr.write(`metrics:skills: ${msg}\n`);
  return code;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.exit(fail(errText(err)));
}
