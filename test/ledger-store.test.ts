import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import {
  LEDGER_HEADING,
  LEDGER_MAX_TASKS,
  LEDGER_TASK_CHARS,
  threadLedger,
} from "../src/storage/ledger-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { upsertStage } from "../src/storage/stage-store";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const mk = (
  db: any,
  id: string,
  o: { brief?: string; thread?: string; role?: string; repo?: string } = {},
) =>
  insertTurn(db, {
    id,
    threadId: o.thread ?? "th",
    source: "t",
    repo: o.repo ?? "r",
    role: o.role ?? "dev",
    brief: o.brief ?? `brief of ${id}`,
  });

test("empty when the thread has no code task (Q&A rows and other threads do not count)", () => {
  const { db } = makeEnv();
  mk(db, "q1", { role: "assistant" });
  mk(db, "c1", { thread: "other" });
  expect(threadLedger(db, "th")).toBe("");
});

test("entry per task: role, status, brief, repo, stages with model, cost, verdict", () => {
  const { db } = makeEnv();
  mk(db, "abcdef123456", { brief: "Add b.txt\nwith   two", repo: "real" });
  finishTurn(db, "abcdef123456", "done");
  upsertStage(db, {
    turnId: "abcdef123456",
    idx: 0,
    name: "plan",
    status: "done",
    model: "m1",
    verdict: "approved",
  });
  upsertStage(db, {
    turnId: "abcdef123456",
    idx: 1,
    name: "exec",
    status: "done",
    model: "m2",
    costUsd: 0.5,
  });
  expect(threadLedger(db, "th")).toBe(
    [
      LEDGER_HEADING,
      '- abcdef12 dev, done: "Add b.txt with two"',
      "  repo real",
      "  stages: plan done (m1, approved) -> exec done (m2, $0.50)",
    ].join("\n"),
  );
});

test("keeps the last 5 tasks (oldest first) and caps each entry; a brief secret is redacted", () => {
  const { db } = makeEnv();
  for (let i = 1; i <= 7; i++)
    mk(db, `task${i}`, { brief: i === 7 ? `${"x".repeat(5000)} ghp_${"a".repeat(36)}` : "b" });
  const out = threadLedger(db, "th");
  const entries = out.split("\n").filter((l) => l.startsWith("- "));
  expect(entries).toHaveLength(LEDGER_MAX_TASKS);
  expect(entries[0]).toContain("task3");
  expect(entries[4]).toContain("task7");
  expect(out).not.toContain("ghp_");
  for (const e of out.split(/\n(?=- )/).slice(1))
    expect(e.length).toBeLessThanOrEqual(LEDGER_TASK_CHARS);
});

test("an idle thread's assistant sees the ledger in its system prompt; a Q&A-only thread sees none", async () => {
  const env = makeEnv();
  mkdirSync(env.repo, { recursive: true });
  mk(env.db, "c1", { thread: "th1", brief: "Earlier change to the parser" });
  finishTurn(env.db, "c1", "done");
  const prompts: Record<string, string> = {};
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: ((a: any) => {
      prompts[a.prompt] = a.options.systemPrompt.append;
      return (async function* () {
        yield resultMsg();
      })();
    }) as never,
  });
  const t = (text: string, threadId: string) => ({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId,
    text,
  });
  await handle(t("what did we do?", "th1"));
  await handle(t("hello", "th2"));
  expect(prompts["what did we do?"]).toContain(LEDGER_HEADING);
  expect(prompts["what did we do?"]).toContain("Earlier change to the parser");
  expect(prompts.hello).not.toContain(LEDGER_HEADING);
});

test("the repo name is one-line", () => {
  const { db } = makeEnv();
  mk(db, "wt1", { repo: "real\n- injected" });
  const out = threadLedger(db, "th");
  expect(out.split("\n")).toHaveLength(3); // heading, brief, repo line (no stages)
  expect(out).toContain("repo real - injected");
});
