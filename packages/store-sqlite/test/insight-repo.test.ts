import { expect, test } from "bun:test";
import type { RunStep, WakeRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

const DAY = 86_400_000;
const step = (
  id: string,
  kind: RunStep["kind"],
  label: string,
  target: string,
  state: RunStep["state"],
  at: number,
): RunStep => ({
  id,
  kind,
  label,
  target,
  state,
  startedAt: at,
  endedAt: at + 100,
});

/** A store with two turns of `ann` (one old), one turn of `bob`, an owner message, wakes, spend and tickets. */
async function seeded() {
  const s = openEngineStore(":memory:");
  const ann = { kind: "bot", botId: "ann" } as const;
  await s.messages.append({
    conversationId: "bot:ann",
    author: { kind: "user" },
    text: "do it",
    at: 10 * DAY,
  });
  await s.messages.append({
    conversationId: "bot:ann",
    author: ann,
    text: "done",
    at: 10 * DAY + 500,
    run: [
      step("1", "skill", "Used skill", "tdd", "done", 10 * DAY),
      step("2", "command", "Ran", "bun test", "failed", 10 * DAY + 100),
      step("3", "command", "Ran", "bun lint", "done", 10 * DAY + 300),
    ],
  });
  await s.messages.append({
    conversationId: "bot:ann",
    author: ann,
    text: "old",
    at: 1 * DAY,
    run: [step("4", "mcp", "Called", "playwright · browser_navigate", "done", 1 * DAY)],
  });
  await s.messages.append({
    conversationId: "bot:bob",
    author: { kind: "bot", botId: "bob" },
    text: "hi",
    at: 9 * DAY,
  });
  await s.spend.add("ann", "1970-01-11", 0.5);
  await s.spend.add("ann", "1970-01-02", 9);
  const wake = (id: string, status: WakeRow["status"]): WakeRow => ({
    id,
    chainId: id,
    conversationId: "bot:ann",
    targetBot: "ann",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "x",
    status,
    attempts: 1,
    createdAt: 10 * DAY,
    scopeKey: "s",
    priority: "interactive",
    leaseFence: 0,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    nudges: 0,
  });
  await s.wakes.insert(wake("w1", "expired"));
  await s.wakes.insert(wake("w2", "done"));
  const t = await s.tickets.create({
    title: "a",
    status: "todo",
    priority: "normal",
    assigneeBotId: "ann",
    createdBy: { kind: "user" },
    createdAt: 10 * DAY,
  });
  await s.tickets.update(t.id, { status: "blocked" }, 10 * DAY);
  return s;
}

test("runStats groups the bot's steps by kind and name (skill, MCP server, Bash) inside the window", async () => {
  const s = await seeded();
  const stats = await s.insight.runStats("ann", 5 * DAY);
  expect(stats.map((r) => [r.kind, r.name, r.uses, r.failed])).toEqual([
    ["command", "Bash", 2, 1],
    ["skill", "tdd", 1, 0],
  ]);
  expect((await s.insight.runStats("ann", 0)).some((r) => r.name === "playwright")).toBe(true);
});

test("turns lists the bot's turns with steps, newest first, with failures and duration", async () => {
  const s = await seeded();
  const turns = await s.insight.turns("ann", 0, 10);
  expect(turns.map((t) => [t.steps, t.failed])).toEqual([
    [3, 1],
    [1, 0],
  ]);
  expect(turns[0]?.durationMs).toBe(400);
  expect(await s.insight.turns("ann", 0, 1)).toHaveLength(1);
});

test("activity sums turns, failed steps, cost, bad wakes and blocked tickets per bot since a time", async () => {
  const s = await seeded();
  const rows = await s.insight.activity(5 * DAY);
  const ann = rows.find((r) => r.botId === "ann");
  expect(ann).toMatchObject({
    turns: 1,
    failedSteps: 1,
    costUsd: 0.5,
    badWakes: 1,
    blockedTickets: 1,
  });
  expect(ann?.lastAt).toBe(10 * DAY + 500);
  expect(rows.find((r) => r.botId === "bob")).toMatchObject({ turns: 0, lastAt: 9 * DAY });
});
