import type { IntentDecision } from "../src/intent/decide-intent";
import type { GoldenCase } from "./intent-eval-cases";

/* Rendering of the live golden run: per-case table, per-group scores and the cost line (no behavior, no calls). */

/** Result of one case. */
export interface Row {
  c: GoldenCase;
  layer: "L1" | "L3" | "fallback" | "none";
  decision: IntentDecision;
  ms: number;
  /** Pass flag per scored dimension (absent = not scored for this case). */
  role?: boolean;
  scope?: boolean;
  cls?: boolean;
  /** Raw class pass (the decision's own class, missing = fail); `cls` is the EFFECTIVE one the gate uses. */
  clsRaw?: boolean;
  /** A change request that reached a non-dev role (or no role) on an idle thread. */
  codeLeak: boolean;
}

type Dim = "role" | "scope" | "cls" | "clsRaw";

/** Short text of a decision for the table. */
const show = (d: IntentDecision) =>
  d.kind === "role"
    ? `${d.role}/${d.scope}${d.cls ? `/${d.cls}` : ""}`
    : d.kind === "ask"
      ? `ask(${d.reason})`
      : d.kind === "control"
        ? `control(${d.action})`
        : `gate-answer(${d.answer})`;

/** Pass count of one dimension over some rows (rows where it is not scored are skipped). */
export function rate(k: Dim, of: Row[]) {
  const scored = of.filter((r) => r[k] !== undefined);
  const pass = scored.filter((r) => r[k]).length;
  return { pass, total: scored.length, ratio: scored.length ? pass / scored.length : 1 };
}

const fmt = (r: { pass: number; total: number }) => `${r.pass}/${r.total}`;

/** The cost line. `total_cost_usd` on a subscription login is a list-price estimate, NOT billing. */
export function costLine(c: { usd: number; calls: number }, maxUsd: number, capped: boolean) {
  const avg = c.calls ? c.usd / c.calls : 0;
  return `cost: total $${c.usd.toFixed(4)} over ${c.calls} SDK call(s), average $${avg.toFixed(4)} per call, cap $${maxUsd}${capped ? " EXCEEDED, run aborted (overshoot <= one call)" : ""}. total_cost_usd is a list-price estimate on a subscription login, not billing.`;
}

/** Markdown table of the rows. */
export function renderTable(rows: Row[]): string {
  return [
    "| # | state | message | expected | actual | layer | ms | role | scope | class |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r, i) => {
      const e = r.c.expect;
      const exp = e.ask
        ? "ask"
        : e.pendingAnswer
          ? `answer:${e.pendingAnswer}`
          : e.anyRegistryRoleOrAsk
            ? "any|ask"
            : `${e.role ?? "-"}/${e.scope ?? "-"}/${e.cls ?? "-"}`;
      const mark = (v?: boolean) => (v === undefined ? "." : v ? "ok" : "MISS");
      return `| ${i + 1} | ${r.c.thread.state} | ${r.c.text.replace(/\|/g, "/").slice(0, 60)} | ${exp} | ${show(r.decision)} | ${r.layer} | ${r.ms} | ${mark(r.role)} | ${mark(r.scope)} | ${mark(r.cls)} |`;
    }),
  ].join("\n");
}

/** Summary lines: cost, per-group scores, totals, leaks and layers. */
export function renderSummary(rows: Row[], cost: string, model: string): string {
  const grp = (name: string, of: Row[]) =>
    `${name}: role ${fmt(rate("role", of))}, scope ${fmt(rate("scope", of))}, class effective ${fmt(rate("cls", of))} (raw ${fmt(rate("clsRaw", of))})`;
  const groups = `${grp(
    "tuning",
    rows.filter((r) => r.c.group !== "holdout"),
  )} | ${grp(
    "holdout",
    rows.filter((r) => r.c.group === "holdout"),
  )}`;
  const byLayer: Record<string, number> = {};
  for (const r of rows) byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1;
  const leaks = rows.filter((r) => r.codeLeak).length;
  return `${cost}\n${groups}\nrole ${fmt(rate("role", rows))}, scope ${fmt(rate("scope", rows))}, class effective ${fmt(rate("cls", rows))} (raw ${fmt(rate("clsRaw", rows))}); code requests leaked to a non-dev role while idle: ${leaks}; layers ${JSON.stringify(byLayer)}; model ${model}`;
}
