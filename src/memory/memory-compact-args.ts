import type { CompactResult } from "./memory-compaction";

/** Parsed CLI arguments of `memory:compact`. */
export interface CompactArgs {
  dryRun: boolean;
  global: boolean;
  workspace?: string;
}

/** Usage text printed on a bad command line. */
export const COMPACT_USAGE =
  "usage: bun run memory:compact [--dry-run] [--global] [--workspace <name>]";

/**
 * Strict argument parser: only `--dry-run`, `--global` and `--workspace <name>` exist. Anything else (a typo
 * such as `--dryrun`) is an error, so a mistyped flag can never start a REAL compaction.
 */
export function parseCompactArgs(argv: string[]): CompactArgs | { error: string } {
  const out: CompactArgs = { dryRun: false, global: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--global") out.global = true;
    else if (a === "--workspace") {
      const name = argv[++i];
      if (!name || name.startsWith("--")) return { error: "--workspace needs a name" };
      out.workspace = name;
    } else return { error: `unknown argument: ${a}` };
  }
  return out;
}

/** Exit code of a run: 1 when any file aborted, was busy or changed; 0 on success or nothing to do. */
export const compactExitCode = (results: CompactResult[]): number =>
  results.some((r) => r.status === "aborted" || r.status === "busy" || r.status === "changed")
    ? 1
    : 0;
