import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listByGoal } from "../src/storage/artifact-store";

/* Support of the researcher eval (web research by the `researcher` role): the fixture loader, the URL extractor and the scorer over one case's db. */

/** Worker role measured by the research eval (its item, artifacts and runs). */
export const RESEARCHER_ROLE = "researcher";

/** Research shapes a case may have (grouping only). */
export const KINDS = ["quick", "technical", "deep", "academic", "market"] as const;

/** One owner research question. */
export interface ResearchCase {
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
  c: Pick<ResearchCase, "expect">,
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

/** RESEARCHER_EVAL_FORCE=1 (alias SCOUT_EVAL_FORCE): the first message names a research worker, so researcher quality is measured apart from routing. */
export const forceText = (text: string): string =>
  `Use a research worker (the researcher) for this, do not answer it yourself: ${text}`;

/** The fixture file (test/fixtures/researcher-research.json). */
export const loadResearchCases = (): ResearchCase[] =>
  (
    JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "researcher-research.json"), "utf8"),
    ) as {
      cases: ResearchCase[];
    }
  ).cases;

/** Distinct http(s) URLs of a text, trailing punctuation and markdown closers trimmed. */
export function urlsOf(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;:!?*_]+$/, "")))];
}

/** What one case produced (one case per db). */
export interface ResearchOutcome {
  /** A researcher item ended COMPLETED (its `Report result.status`). */
  completed: boolean;
  /** Result excerpt plus the text of the artifacts the researcher saved. */
  text: string;
  costUsd: number;
  durationMs: number;
}

/** Read a worker's outcome from the db (default the researcher; the scout codebase eval passes `scout`): its item row, its saved artifacts (store files) and its run metrics. */
export function outcomeOf(
  db: Database,
  readFile: (path: string) => string,
  role: string = RESEARCHER_ROLE,
): ResearchOutcome {
  const item = db
    .query<{ parent: string; status: string; excerpt: string | null }, [string]>(
      "SELECT parent_id AS parent, status, result_excerpt AS excerpt FROM owned_tasks WHERE parent_id IS NOT NULL AND owner_role = ? ORDER BY rowid LIMIT 1",
    )
    .get(role);
  if (!item) return { completed: false, text: "", costUsd: 0, durationMs: 0 };
  // The worker's saved reports: store files of its goal written by that role.
  const files = listByGoal(db, item.parent).filter(
    (a) => a.origin === "store" && a.producerRole === role,
  );
  const run = db
    .query<{ cost: number; ms: number }, [string]>(
      "SELECT COALESCE(SUM(r.cost_usd), 0) AS cost, COALESCE(SUM(r.duration_ms), 0) AS ms FROM runs r JOIN turns t ON t.id = r.turn_id WHERE t.role = ?",
    )
    .get(role);
  return {
    completed: item.status === "completed",
    text: [item.excerpt ?? "", ...files.map((f) => readFile(f.path))].join("\n"),
    costUsd: run?.cost ?? 0,
    durationMs: run?.ms ?? 0,
  };
}
