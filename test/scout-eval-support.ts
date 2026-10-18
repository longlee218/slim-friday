import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listByGoal } from "../src/storage/artifact-store";

/* Support of the scout research eval: the fixture loader, the URL extractor and the scorer over one case's db. */

/** Research shapes a case may have (grouping only). */
export const KINDS = ["quick", "technical", "deep", "academic", "market"] as const;

/** One owner research question. */
export interface ScoutCase {
  id: string;
  kind: (typeof KINDS)[number];
  text: string;
  /** `dispatch`: the lead must hand it to a worker (a direct answer is a MISS); `either` (default): a sure direct answer is fine. */
  expect?: "dispatch" | "either";
}

/** How one case ended: `ok` (dispatched and passed), `routed-direct` (lead answered, allowed), `MISS`. */
export type Verdict = "ok" | "routed-direct" | "MISS";

/** Score one case: a direct answer is a miss only for a must-dispatch case; a dispatched case must pass. */
export function verdictOf(
  c: Pick<ScoutCase, "expect">,
  dispatched: boolean,
  pass: boolean,
): Verdict {
  if (!dispatched) return c.expect === "dispatch" ? "MISS" : "routed-direct";
  return pass ? "ok" : "MISS";
}

/** Counts of a run: dispatch rate over all cases, pass rate over the DISPATCHED cases only. */
export function summarize(rows: { verdict: Verdict; dispatched: boolean }[]) {
  const dispatched = rows.filter((r) => r.dispatched).length;
  const ok = rows.filter((r) => r.verdict === "ok").length;
  const direct = rows.filter((r) => r.verdict === "routed-direct").length;
  return {
    dispatched,
    ok,
    direct,
    miss: rows.filter((r) => r.verdict === "MISS").length,
    /** Pass rate over dispatched cases (1 when none was dispatched and none missed). */
    passRate: dispatched ? ok / dispatched : 1,
  };
}

/** SCOUT_EVAL_FORCE=1: the first message names a research worker, so scout quality is measured apart from routing. */
export const forceText = (text: string): string =>
  `Use a research worker (the scout) for this, do not answer it yourself: ${text}`;

/** The fixture file (test/fixtures/scout-research.json). */
export const loadScoutCases = (): ScoutCase[] =>
  (
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "scout-research.json"), "utf8")) as {
      cases: ScoutCase[];
    }
  ).cases;

/** Distinct http(s) URLs of a text, trailing punctuation and markdown closers trimmed. */
export function urlsOf(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?*_]+$/, "")))];
}

/** What one case produced (one case per db). */
export interface ScoutOutcome {
  /** A scout item ended COMPLETED (its `ReportResult.status`). */
  completed: boolean;
  /** Result excerpt plus the text of the artifacts the scout saved. */
  text: string;
  costUsd: number;
  durationMs: number;
}

/** Read the scout's outcome from the db: its item row, its saved artifacts (store files) and its run metrics. */
export function outcomeOf(db: Database, readFile: (path: string) => string): ScoutOutcome {
  const item = db
    .query<{ parent: string; status: string; excerpt: string | null }, []>(
      "SELECT parent_id AS parent, status, result_excerpt AS excerpt FROM owned_tasks WHERE parent_id IS NOT NULL AND owner_role = 'scout' ORDER BY rowid LIMIT 1",
    )
    .get();
  if (!item) return { completed: false, text: "", costUsd: 0, durationMs: 0 };
  // The scout's saved reports: store files of its goal written by the scout role.
  const files = listByGoal(db, item.parent).filter(
    (a) => a.origin === "store" && a.producerRole === "scout",
  );
  const run = db
    .query<{ cost: number; ms: number }, []>(
      "SELECT COALESCE(SUM(r.cost_usd), 0) AS cost, COALESCE(SUM(r.duration_ms), 0) AS ms FROM runs r JOIN turns t ON t.id = r.turn_id WHERE t.role = 'scout'",
    )
    .get();
  return {
    completed: item.status === "completed",
    text: [item.excerpt ?? "", ...files.map((f) => readFile(f.path))].join("\n"),
    costUsd: run?.cost ?? 0,
    durationMs: run?.ms ?? 0,
  };
}
