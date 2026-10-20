import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** One role's skill use over the window. */
export interface RoleSkillStats {
  role: string;
  runs: number;
  /** Mean number of distinct skills a run called. */
  avgCalled: number;
  /** Skills given to at least one run of the role and called by none. */
  neverCalled: string[];
}

/**
 * Aggregates `skills.used` lines (JSONL text of the app log) at or after `sinceMs` per role. Lines that are not JSON or
 * not that event are skipped, so a log with other events (or a half-written last line) is fine.
 */
export function skillsMetricsFromLines(lines: Iterable<string>, sinceMs: number): RoleSkillStats[] {
  const roles = new Map<
    string,
    { runs: number; called: number; available: Set<string>; used: Set<string> }
  >();
  for (const line of lines) {
    if (!line.includes('"skills.used"')) continue;
    let e: {
      event?: string;
      time?: number;
      role?: string;
      available?: string[];
      called?: string[];
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.event !== "skills.used" || !e.role || (e.time ?? 0) < sinceMs) continue;
    const r = roles.get(e.role) ?? { runs: 0, called: 0, available: new Set(), used: new Set() };
    r.runs++;
    r.called += e.called?.length ?? 0;
    for (const s of e.available ?? []) r.available.add(s);
    for (const s of e.called ?? []) r.used.add(s);
    roles.set(e.role, r);
  }
  return [...roles.entries()]
    .map(([role, r]) => ({
      role,
      runs: r.runs,
      avgCalled: r.called / r.runs,
      neverCalled: [...r.available].filter((s) => !r.used.has(s)).sort(),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/** Every line of the app log files (`<base>.<date>.<n>.jsonl`, `base` = `.../logs/app`). */
export function* readAppLogLines(appLogBase: string): Generator<string> {
  const dir = dirname(appLogBase);
  const prefix = `${basename(appLogBase)}.`;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"));
  } catch {
    return; // no log dir yet
  }
  for (const f of files.sort()) yield* readFileSync(join(dir, f), "utf8").split("\n");
}

/** Text table of the stats for stdout. */
export function formatSkillsMetrics(stats: RoleSkillStats[], days: number): string {
  if (!stats.length) return `skills.used: no worker runs in the last ${days} day(s)`;
  const out = [`Skill use per role, last ${days} day(s)`];
  for (const s of stats) {
    out.push(
      `- ${s.role}: ${s.runs} run(s), avg ${s.avgCalled.toFixed(1)} skill(s) called`,
      `  never called: ${s.neverCalled.length ? s.neverCalled.join(", ") : "none"}`,
    );
  }
  return out.join("\n");
}
