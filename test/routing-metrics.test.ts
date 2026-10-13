import { expect, test } from "bun:test";
import {
  computeRoutingMetrics,
  formatMetricsTable,
  type LogEvent,
  percentile,
  type RouteLabel,
} from "../src/observability/routing-metrics";

const span = (traceId: string, name: string, durationMs: number): LogEvent => ({
  event: "span",
  traceId,
  span: name,
  durationMs,
});
const decision = (traceId: string, o: Record<string, unknown> = {}): LogEvent => ({
  event: "route.decision",
  traceId,
  source: "jev",
  candidateAgentId: "a",
  ...o,
});

/** t1 jev pick, t2 jev undecided -> haiku fallback, t3 rerouted a -> b (owner changed), t4 tag. */
const events: LogEvent[] = [
  decision("t1", { jev: { band: "pick" } }),
  span("t1", "classify", 100),
  span("t1", "preflight", 10),
  span("t1", "execute", 9999), // not a routing span
  { event: "llm.turn", traceId: "t1", kind: "jev", inputTokens: 100, outputTokens: 20 },
  decision("t2", { source: "fallback", jev: { band: "undecided:unclear" } }),
  span("t2", "classify", 300),
  { event: "llm.turn", traceId: "t2", kind: "jev", inputTokens: 50, outputTokens: 10 },
  { event: "llm.turn", traceId: "t2", kind: "intent", costUsd: 0.004 },
  decision("t3", { source: "fallback", rerouted: true, candidateAgentId: "b" }),
  { event: "task.owner_changed", traceId: "t3" },
  span("t3", "preflight", 40),
  decision("t4", { source: "tag" }),
  span("t4", "resolve_context", 1000),
  { event: "route.decision" }, // no traceId: ignored by trace joins, still a decision? (no)
];

test("unlabeled metrics from fixture logs", () => {
  const m = computeRoutingMetrics(events);
  expect(m.handoff_correction_rate).toEqual({ value: 1 / 4, n: 4 });
  // per-trace sums: t1 110, t2 300, t3 40, t4 1000 -> p95 (nearest rank of 4) = 1000
  expect(m.routing_latency_p95_ms).toEqual({ value: 1000, n: 4 });
  expect(m.routing_cost_usd_per_turn.value).toBeCloseTo(0.001);
  expect(m.jev_tokens_per_turn.value).toBe((120 + 60) / 4);
  expect(m.jev_fallback_rate).toEqual({ value: 0.5, n: 2 });
});

test("labeled metrics are n/a (0 labeled) without labels, with the sample size next to every rate", () => {
  const m = computeRoutingMetrics(events);
  for (const k of [
    "wrong_route_rate",
    "unnecessary_fallback_rate",
    "route_recovery_success_rate",
    "context_drift_rate",
    "task_completion_rate",
  ])
    expect(m[k]).toEqual({ value: null, n: 0, labeled: 0 });
  expect(formatMetricsTable(m)).toContain("n/a (0 labeled)");
});

test("labeled metrics join by traceId", () => {
  const labels: RouteLabel[] = [
    { traceId: "t1", correctRole: "a", simple: true, continuity: true, taskCorrect: true },
    { traceId: "t2", correctRole: "b", simple: true, taskCorrect: false },
    { traceId: "t3", correctRole: "b", continuity: true },
    { traceId: "nope", correctRole: "x" },
  ];
  const m = computeRoutingMetrics(events, labels);
  expect(m.wrong_route_rate).toEqual({ value: 1 / 3, n: 3, labeled: 3 }); // only t2 wrong
  expect(m.unnecessary_fallback_rate).toEqual({ value: 0.5, n: 2, labeled: 2 }); // t2 fallback of t1,t2
  expect(m.route_recovery_success_rate).toEqual({ value: 1, n: 1, labeled: 1 }); // t3 ended on b
  expect(m.context_drift_rate).toEqual({ value: 0.5, n: 2, labeled: 2 }); // t3 owner changed
  expect(m.task_completion_rate).toEqual({ value: 0.5, n: 2, labeled: 2 });
});

test("empty input: no crash, every value null; percentile edges", () => {
  const m = computeRoutingMetrics([]);
  expect(Object.values(m).every((x) => x.value === null)).toBe(true);
  expect(percentile([], 0.95)).toBeNull();
  expect(percentile([5], 0.95)).toBe(5);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
});

// A JSONL line may parse to a non-object (`null`, `5`); the CLI forwards parsed lines as-is.
test("non-object log entries do not crash the metrics", () => {
  const junk = [null, 5, "x"] as unknown as LogEvent[];
  expect(() => computeRoutingMetrics(junk)).not.toThrow();
});
