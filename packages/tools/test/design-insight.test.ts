import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexedMessage, InsightStore } from "@friday/core";
import { redactSecrets } from "../src/design/insight/redact";
import { createBotInsightTool } from "../src/design/tools/BotInsightTool/bot-insight-tool";
import { call, setup, textOf } from "./design-fixture";

const DAY = 86_400_000;
const NOW = 40 * DAY;

/** A fake insight store: `ann` used Bash (1 failed) and the skill tdd; never the skill docs or playwright. */
const insight: InsightStore = {
  runStats: async () => [
    { kind: "tool", name: "Bash", uses: 4, failed: 1, lastAt: NOW - DAY },
    { kind: "skill", name: "tdd", uses: 2, failed: 0, lastAt: NOW - 2 * DAY },
  ],
  turns: async (_b, _s, limit) =>
    [
      {
        messageId: 7,
        conversationId: "bot:ann",
        at: NOW - DAY,
        steps: 3,
        failed: 1,
        durationMs: 90_000,
      },
      {
        messageId: 5,
        conversationId: "bot:ann",
        at: NOW - 2 * DAY,
        steps: 1,
        failed: 0,
        durationMs: 1_000,
      },
    ].slice(0, limit),
  activity: async () => [
    {
      botId: "ann",
      turns: 2,
      failedSteps: 1,
      lastAt: NOW - DAY,
      costUsd: 1.25,
      badWakes: 1,
      blockedTickets: 0,
    },
  ],
};

const msgs: IndexedMessage[] = [
  {
    id: 6,
    conversationId: "bot:ann",
    author: { kind: "user" },
    text: "fix the login, key sk-ant-abcdefghijklmnop1234",
    at: NOW - DAY - 10,
  },
  {
    id: 7,
    conversationId: "bot:ann",
    author: { kind: "bot", botId: "ann" },
    text: "Fixed.",
    at: NOW - DAY,
    run: [
      {
        id: "a",
        kind: "tool",
        label: "Bash",
        target: "bun test",
        state: "failed",
        startedAt: 1,
        endedAt: 2001,
      },
      { id: "b", kind: "skill", label: "tdd", state: "done", startedAt: 3000 },
    ],
  },
];

function ctxWithAnn() {
  const s = setup({
    now: () => NOW,
    insight,
    messages: {
      get: async (id) => msgs.find((m) => m.id === id),
      page: async (_c, f) =>
        msgs
          .filter((m) => m.id < (f.before ?? Infinity))
          .reverse()
          .slice(0, f.limit),
    },
  });
  writeFileSync(
    join(s.configDir, "bots", "ann.md"),
    "---\nname: Ann\ntitle: dev\nmodel: sonnet\ntools: [Read, Bash, mcp__playwright]\nskills: [tdd, docs]\n---\nYou build things. ".concat(
      "x".repeat(400),
      "\n",
    ),
  );
  s.ctx.botSummaries = () => [{ id: "ann", name: "Ann", title: "dev" }];
  return { ...s, tool: createBotInsightTool(s.ctx) };
}

test("overview lists each bot's turns, failures, cost and stuck work", async () => {
  const { tool } = ctxWithAnn();
  const t = textOf(await call(tool, { action: "overview" }));
  expect(t).toContain("ann");
  expect(t).toContain("$1.25");
  expect(t).toContain("1 bad wake");
});

test("bot_report shows use per step and what the bot file lists but never used", async () => {
  const { tool } = ctxWithAnn();
  const t = textOf(await call(tool, { action: "bot_report", id: "ann", days: 30 }));
  expect(t).toContain("tool Bash: 4 uses, 1 failed");
  expect(t).toMatch(/Unused in 30 days:[\s\S]*skill docs/);
  expect(t).toMatch(/Unused in 30 days:[\s\S]*mcp__playwright/);
  expect(t).not.toMatch(/Unused in 30 days:[\s\S]*skill tdd/);
  expect(t).toMatch(/Prompt size: ~\d+ tokens/);
});

test("list_runs lists turns; filter failed keeps turns with a failed step", async () => {
  const { tool } = ctxWithAnn();
  const all = textOf(await call(tool, { action: "list_runs", id: "ann" }));
  expect(all).toContain("#7");
  expect(all).toContain("#5");
  const failed = textOf(await call(tool, { action: "list_runs", id: "ann", filter: "failed" }));
  expect(failed).toContain("#7");
  expect(failed).not.toContain("#5");
});

test("read_run shows the ask, the reply and the steps as data, with secrets hidden", async () => {
  const { tool } = ctxWithAnn();
  const t = textOf(await call(tool, { action: "read_run", messageId: 7 }));
  expect(t).toContain("<run");
  expect(t).toContain("fix the login");
  expect(t).not.toContain("sk-ant-abcdefghijklmnop1234");
  expect(t).toContain("tool Bash bun test FAILED 2.0s");
});

test("unknown bot, unknown message and a message that is not a bot turn are refused", async () => {
  const { tool } = ctxWithAnn();
  expect((await call(tool, { action: "bot_report", id: "ghost" })).isError).toBe(true);
  expect((await call(tool, { action: "read_run", messageId: 99 })).isError).toBe(true);
  expect((await call(tool, { action: "read_run", messageId: 6 })).isError).toBe(true);
});

test("redactSecrets hides common token shapes and PEM blocks", () => {
  const s = redactSecrets(
    "a ghp_abcdefghijklmnopqrstuvwx1234 b AKIAABCDEFGHIJKLMNOP c Bearer abc.def-ghi xoxb-123-456-abc\n-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----",
  );
  expect(s).not.toMatch(/ghp_|AKIA|abc\.def|xoxb|MII/);
});
