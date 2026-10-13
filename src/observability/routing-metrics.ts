/**
 * Offline routing metrics (pure: log events + human labels in, numbers out). Metadata only: the inputs are
 * `route.decision`, `preflight.result`, `execution.outcome`, `task.owner_changed`, `span` and `llm.turn` lines
 * (grouped by `traceId`) plus a labels file of ids and role names; never message text.
 */

/** One parsed log line (pino JSON). Only the fields read here are typed. */
export interface LogEvent {
  event?: string;
  traceId?: string;
  /** epoch ms (pino default). */
  time?: number;
  [k: string]: unknown;
}

/** One human label per trace (`{traceId, correctRole, continuity?, topicSwitch?, taskCorrect?, simple?}`). */
export interface RouteLabel {
  traceId: string;
  correctRole: string;
  continuity?: boolean;
  topicSwitch?: boolean;
  taskCorrect?: boolean;
  /** The message was simple enough for the deterministic / Jev route (a Haiku fallback was unnecessary). */
  simple?: boolean;
}

/** A rate or a number with the sample size behind it (`value` null = nothing to measure). */
export interface Metric {
  value: number | null;
  /** Count of events / traces the value is computed over. */
  n: number;
  /** Labeled metrics only: how many labels it used. */
  labeled?: number;
}

export type RoutingMetrics = Record<string, Metric>;

/** Span names that make up routing latency. */
const ROUTING_SPANS = new Set(["resolve_context", "classify", "select_candidate", "preflight"]);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rate = (hit: number, of: number): Metric => ({ value: of ? hit / of : null, n: of });
const labeledRate = (hit: number, of: number): Metric => ({ ...rate(hit, of), labeled: of });

/** Nearest-rank percentile (p in 0..1) of a number list; null when empty. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? null;
}

/** Group events by traceId (events without one are ignored). */
function byTrace(events: LogEvent[]): Map<string, LogEvent[]> {
  const m = new Map<string, LogEvent[]>();
  for (const e of events) if (e?.traceId) m.set(e.traceId, [...(m.get(e.traceId) ?? []), e]);
  return m;
}

/** Compute every routing metric. Labeled metrics read only traces present in `labels`. */
export function computeRoutingMetrics(
  events: LogEvent[],
  labels: RouteLabel[] = [],
): RoutingMetrics {
  const traces = byTrace(events);
  const lbl = new Map(labels.map((l) => [l.traceId, l]));
  const decisions: { trace: string; e: LogEvent }[] = [];
  for (const [trace, evs] of traces)
    for (const e of evs) if (e.event === "route.decision") decisions.push({ trace, e });
  const ownerChanged = new Set<string>();
  for (const e of events)
    if (e?.event === "task.owner_changed" && e.traceId) ownerChanged.add(e.traceId);
  const corrected = (d: { trace: string; e: LogEvent }) =>
    d.e.rerouted === true || ownerChanged.has(d.trace);

  // Latency: sum of routing spans per trace that has a decision.
  const latencies = decisions.map(({ trace }) =>
    (traces.get(trace) ?? [])
      .filter((e) => e.event === "span" && ROUTING_SPANS.has(String(e.span)))
      .reduce((s, e) => s + num(e.durationMs), 0),
  );
  // Cost: intent-model USD + Jev tokens, per routed message.
  const llm = (trace: string, kind: string) =>
    (traces.get(trace) ?? []).filter((e) => e.event === "llm.turn" && e.kind === kind);
  const sum = (f: (t: string) => number) => decisions.reduce((s, d) => s + f(d.trace), 0);
  const per = (total: number): Metric => ({
    value: decisions.length ? total / decisions.length : null,
    n: decisions.length,
  });
  const jevTokens = sum((t) =>
    llm(t, "jev").reduce((s, e) => s + num(e.inputTokens) + num(e.outputTokens), 0),
  );

  // Jev: attempted = a decision carrying Jev numbers; undecided = the Haiku fallback ran after it.
  const attempted = decisions.filter((d) => d.e.jev && typeof d.e.jev === "object");
  const undecided = attempted.filter((d) =>
    String((d.e.jev as { band?: unknown }).band ?? "").startsWith("undecided"),
  );

  // Labeled joins.
  const joined = decisions.flatMap((d) => {
    const l = lbl.get(d.trace);
    return l ? [{ ...d, l }] : [];
  });
  const wrong = joined.filter((j) => j.e.candidateAgentId !== j.l.correctRole);
  const simple = joined.filter((j) => j.l.simple === true);
  const reroutedLabeled = joined.filter((j) => j.e.rerouted === true);
  const continuity = joined.filter((j) => j.l.continuity === true);
  const drift = continuity.filter(
    (j) => j.e.candidateAgentId !== j.l.correctRole || ownerChanged.has(j.trace),
  );
  const completion = joined.filter((j) => j.l.taskCorrect !== undefined);

  return {
    handoff_correction_rate: rate(decisions.filter(corrected).length, decisions.length),
    routing_latency_p95_ms: { value: percentile(latencies, 0.95), n: latencies.length },
    routing_cost_usd_per_turn: per(
      sum((t) => llm(t, "intent").reduce((s, e) => s + num(e.costUsd), 0)),
    ),
    jev_tokens_per_turn: per(jevTokens),
    jev_fallback_rate: rate(undecided.length, attempted.length),
    unnecessary_fallback_rate: labeledRate(
      simple.filter((j) => j.e.source === "fallback").length,
      simple.length,
    ),
    wrong_route_rate: labeledRate(wrong.length, joined.length),
    route_recovery_success_rate: labeledRate(
      reroutedLabeled.filter((j) => j.e.candidateAgentId === j.l.correctRole).length,
      reroutedLabeled.length,
    ),
    context_drift_rate: labeledRate(drift.length, continuity.length),
    task_completion_rate: labeledRate(
      completion.filter((j) => j.l.taskCorrect === true).length,
      completion.length,
    ),
  };
}

/** Plain table of the metrics (`n/a (0 labeled)` when a labeled metric has no labels, `n/a` when no events). */
export function formatMetricsTable(m: RoutingMetrics): string {
  const rows = Object.entries(m).map(([name, x]) => {
    const shown =
      x.value === null
        ? x.labeled !== undefined
          ? "n/a (0 labeled)"
          : "n/a"
        : name.endsWith("_rate")
          ? `${(x.value * 100).toFixed(1)}%`
          : Number.isInteger(x.value)
            ? String(x.value)
            : x.value.toFixed(4);
    return `${name.padEnd(30)} ${shown.padStart(16)}  (n=${x.n})`;
  });
  return rows.join("\n");
}
