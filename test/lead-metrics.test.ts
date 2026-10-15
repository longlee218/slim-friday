import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { formatLeadMetrics, leadMetrics } from "../src/observability/lead-metrics";
import { appendEvent } from "../src/orchestrator/events/event-store";
import { openDb } from "../src/storage/db";
import { appendEffect } from "../src/storage/effect-log-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";

let db: Database;
afterEach(() => db?.close());

/** A lead tool call audit row (what `leadCall` writes on success). */
const call = (id: string, tool: string) =>
  appendEffect(db, {
    id,
    threadId: "th",
    tool,
    scope: "lead tool call",
    grantedBy: "role",
    result: '{"ok":true}',
  });

/** A run of `role` with cost `usd`, its turn started `ageMs` ago. */
function run(id: string, role: string, usd: number, ageMs: number) {
  insertTurn(db, { id, threadId: "th", source: "t", location: "r", role });
  db.query("UPDATE turns SET started_at = ? WHERE id = ?").run(Date.now() - ageMs, id);
  insertRun(db, {
    id: `r-${id}`,
    turnId: id,
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: usd,
    turns: 1,
    durationMs: 1,
    outcome: "ok",
    compactions: 0,
  });
}

function seed() {
  db = openDb(":memory:");
  call("k1", "DispatchAgent");
  call("k2", "DispatchAgent");
  call("k3", "AskOwner");
  // Refused lead call (id holds `:refused:`) and a normal event that must not count.
  appendEvent(db, {
    id: "k9:refused:u1",
    threadId: "th",
    kind: "lead_decision",
    payload: { tool: "DispatchAgent", ok: false, code: "BUDGET", by: "lead" },
  });
  appendEvent(db, {
    id: "k1:0",
    threadId: "th",
    kind: "start",
    payload: { by: "lead", tool: "DispatchAgent" },
  });
  // Envelope blocks: a refused push and an owner-denied merge; a granted push is not a block.
  const effect = (id: string, tool: string, result: string) =>
    appendEffect(db, { id, threadId: "th", tool, scope: "x", grantedBy: "owner", result });
  effect("e1", "GitPush", '{"result":"refused","code":"NOT_IN_ENVELOPE"}');
  effect("e2", "MergeBranch", '{"result":"denied","code":"OWNER_NO"}');
  effect("e3", "GitPush", '{"result":"pushed"}');
  run("lead-1", "lead", 0.25, 0);
  run("dev-1", "developer", 1, 0);
  run("old", "lead", 9, 30 * 86_400_000); // outside the window
}

test("decisions, refusals, envelope blocks count only their own rows", () => {
  seed();
  const m = leadMetrics(db, 7);
  expect(m.decisions).toEqual([
    { tool: "DispatchAgent", count: 2 },
    { tool: "AskOwner", count: 1 },
  ]);
  expect(m.refusals).toEqual([{ tool: "DispatchAgent", code: "BUDGET", count: 1 }]);
  expect(m.envelopeBlocks.map((b) => `${b.tool}:${b.code}`).sort()).toEqual([
    "GitPush:NOT_IN_ENVELOPE",
    "MergeBranch:OWNER_NO",
  ]);
});

test("cost per day: window respected, lead share split from the total", () => {
  seed();
  const m = leadMetrics(db, 7);
  expect(m.costPerDay).toHaveLength(1);
  expect(m.costPerDay[0]).toMatchObject({ totalUsd: 1.25, leadUsd: 0.25 });
  expect(leadMetrics(db, 60).costPerDay).toHaveLength(2);
});

test("empty db prints (none) sections and the omitted note", () => {
  db = openDb(":memory:");
  const text = formatLeadMetrics(leadMetrics(db, 7), 7);
  expect(text).toContain("(none)");
  expect(text).toContain("Not recorded");
});
