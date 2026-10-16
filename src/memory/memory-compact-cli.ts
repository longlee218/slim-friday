import { loadConfig } from "../config/agent-config";
import { errText } from "../observability/redact";
import { loadWorkspaces } from "../workspaces/workspace-registry";
import { COMPACT_USAGE, compactExitCode, parseCompactArgs } from "./memory-compact-args";
import { compactTargets, sdkCompactLlm } from "./memory-compaction";
import { formatCompactResult } from "./memory-compaction-report";
import { type MemoryTarget, rootTarget, workspaceTargets } from "./memory-targets";
import { ensureHome } from "./persona";

/**
 * CLI: `bun run memory:compact [--dry-run] [--workspace <ws>] [--global]`.
 * No scope flag = every file (root + all workspaces); `--global` = root only; `--workspace <ws>` = that
 * workspace's files. Only files over 80% of their cap are sent to MEMORY_MODEL. Output goes to stdout.
 * Exit codes: 0 success / nothing to do, 1 any file aborted/busy/changed or a setup error, 2 bad arguments.
 */
async function main(argv: string[]): Promise<number> {
  const args = parseCompactArgs(argv);
  if ("error" in args) return fail(`${args.error}\n${COMPACT_USAGE}`, 2);
  const config = loadConfig();
  if (!config.hasRealAuth) return fail(`CLAUDE_CODE_OAUTH_TOKEN missing or placeholder`);
  const { workspaces } = loadWorkspaces(config.agentHome);
  ensureHome(config.agentHome, workspaces);
  const chosen = args.workspace ? workspaces.filter((w) => w.name === args.workspace) : workspaces;
  if (args.workspace && chosen.length === 0) return fail(`Unknown workspace: ${args.workspace}`);
  // Root: with --global or when no workspace is named. Workspaces: unless only --global was given.
  const targets: MemoryTarget[] = [
    ...(args.global || !args.workspace ? [rootTarget(config.agentHome)] : []),
    ...(args.global && !args.workspace
      ? []
      : chosen.flatMap((w) => workspaceTargets(config.agentHome, w))),
  ];
  const results = await compactTargets(targets, sdkCompactLlm(config), {
    dryRun: args.dryRun,
    home: config.agentHome,
  });
  process.stdout.write(
    `${results.map((r) => formatCompactResult(r, { full: true })).join("\n")}\n`,
  );
  return compactExitCode(results);
}

/** Print an error to stderr and return the exit code. */
function fail(msg: string, code = 1): number {
  process.stderr.write(`memory:compact: ${msg}\n`);
  return code;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => process.exit(fail(errText(err))),
);
