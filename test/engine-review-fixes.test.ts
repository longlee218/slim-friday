import { expect, test } from "bun:test";
import { TASK_BUDGET_USD } from "../src/config/model-routing";
import { runRole } from "../src/orchestrator/engine/run-role";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { finishRun } from "../src/orchestrator/turns/turn-result";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import {
  addLocation,
  clearWorkspaces,
  initMsg,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/** One finished run row of `turnId` that cost `costUsd`. */
const spend = (db: ReturnType<typeof makeEnv>["db"], turnId: string, costUsd: number) =>
  insertRun(db, {
    id: crypto.randomUUID(),
    turnId,
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    turns: 1,
    durationMs: 1,
    outcome: "max_budget",
    compactions: 0,
  });

/** Dev run of `turnId` over a fake query that records its options. */
async function runDev(env: ReturnType<typeof makeEnv>, turnId: string) {
  const seen: any[] = [];
  const res = await runRole(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: ((a: { options: unknown }) => {
        seen.push(a.options);
        return (async function* () {
          yield resultMsg({ result: "ok" });
        })();
      }) as never,
    },
    {
      turnId,
      threadId: "th",
      language: "en",
      text: "continue",
      role: "dev",
      workspace: "main",
      locations: [{ name: "location", path: env.location } as never],
      ac: new AbortController(),
    },
  );
  return { res, seen };
}

test("task ceiling: a run gets only what the task and the runs it resumes left of TASK_BUDGET_USD", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  // t1 (4.0 spent) <- t2 (resume, 1.5 spent) <- t3 (resume, this run): 5.5 spent in the chain, 0.5 left.
  insertTurn(env.db, { id: "t1", threadId: "th", source: "t", location: "location", role: "dev" });
  insertTurn(env.db, {
    id: "t2",
    threadId: "th",
    source: "t",
    location: "location",
    role: "dev",
    resume: true,
    parentTurnId: "t1",
  });
  insertTurn(env.db, {
    id: "t3",
    threadId: "th",
    source: "t",
    location: "location",
    role: "dev",
    resume: true,
    parentTurnId: "t2",
  });
  // An unrelated task of the same thread does not count.
  insertTurn(env.db, {
    id: "other",
    threadId: "th",
    source: "t",
    location: "location",
    role: "dev",
  });
  spend(env.db, "t1", 4.0);
  spend(env.db, "t2", 1.5);
  spend(env.db, "other", 5.0);
  const { res, seen } = await runDev(env, "t3");
  expect(res.outcome).toBe("success");
  expect(seen[0].maxBudgetUsd).toBeCloseTo(0.5);
  expect(res.ceilingBound).toBe(true); // the cap IS the ceiling: `/go +usd` cannot help
});

test("task ceiling used up: the run is refused before it starts, `/go +usd` cannot lift it", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  insertTurn(env.db, { id: "t1", threadId: "th", source: "t", location: "location", role: "dev" });
  insertTurn(env.db, {
    id: "t2",
    threadId: "th",
    source: "t",
    location: "location",
    role: "dev",
    resume: true,
    parentTurnId: "t1",
  });
  spend(env.db, "t1", TASK_BUDGET_USD);
  const { res, seen } = await runDev(env, "t2");
  expect(res.outcome).toBe("error");
  expect(res.text).toContain("cannot be raised");
  expect(res.text).not.toContain("/go +");
  expect(res.refusal).toBe(true); // a verified refusal: finishRun shows it instead of the generic failure
  expect(seen).toHaveLength(0);
  // the owner reads that copy (localized), not the generic "try again"
  const shown = finishRun(env.db, { turnId: "t2", threadId: "th" }, res, "vi");
  expect(shown).toContain("không thể tăng thêm");
  expect(shown).not.toContain("thử lại");
});

test("a task that is not a resume starts at zero spent (an earlier task of the thread does not count)", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  insertTurn(env.db, { id: "t1", threadId: "th", source: "t", location: "location", role: "dev" });
  insertTurn(env.db, {
    id: "t2",
    threadId: "th",
    source: "t",
    location: "location",
    role: "dev",
    parentTurnId: "t1",
  }); // a proposal hop, not a resume
  spend(env.db, "t1", 5.9);
  const { seen } = await runDev(env, "t2");
  expect(seen[0].maxBudgetUsd).toBe(4.5);
});

test("a thrown run does not leave a run row 'running': the runs row carries the error", async () => {
  const env = makeEnv();
  insertTurn(env.db, {
    id: "t1",
    threadId: "th",
    source: "t",
    location: "location",
    role: "assistant",
  });
  const run = runRole(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: (() => {
        throw new Error("boom");
      }) as never,
    },
    {
      turnId: "t1",
      threadId: "th",
      text: "x",
      role: "assistant",
      workspace: "main",
      locations: [{ name: "location", path: env.location } as never],
      ac: new AbortController(),
    },
  );
  await run.catch(() => undefined);
  expect(env.db.query("SELECT outcome FROM runs").all()).toEqual([{ outcome: "error" }]);
});

test("`go +5` that falls back to a plain message does not carry the raise into Q&A", async () => {
  const env = makeEnv();
  const budgets: unknown[] = [];
  const handler = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: ((a: { options: { maxBudgetUsd?: number } }) => {
      budgets.push(a.options.maxBudgetUsd);
      return (async function* () {
        yield initMsg;
        yield resultMsg();
      })();
    }) as never,
  });
  const send = (threadId: string, text: string) =>
    handler({ source: "t", channelId: TEST_CHANNEL, userId: "u", threadId, text });
  await send("th-a", "where is x?");
  await send("th-b", "go +5");
  expect(budgets).toHaveLength(2);
  expect(budgets[1]).toBe(budgets[0]);
});

/** Dev run input that continues a task in `cwd` (a Resume), with an `onStarted` probe. */
async function runResumed(env: ReturnType<typeof makeEnv>, cwd: string, onStarted: () => void) {
  return runRole(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: (() =>
        (async function* () {
          yield resultMsg({ result: "ok" });
        })()) as never,
    },
    {
      turnId: "t1",
      threadId: "th",
      language: "en",
      text: "continue",
      role: "dev",
      workspace: "main",
      locations: [{ name: "location", path: env.location } as never],
      ac: new AbortController(),
      resume: { sessionId: "s1", cwd },
      onStarted,
    },
  );
}

test("resume: a background session whose cwd is not a registered location is refused and the hold is kept (onStarted not called)", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  let started = 0;
  const res = await runResumed(env, `${env.home}/not-a-location`, () => started++);
  expect(res.outcome).toBe("error");
  expect(res.text).toContain("could not find the location");
  expect(started).toBe(0);
});

test("resume in a registered location: the run starts and onStarted is called once", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  let started = 0;
  const res = await runResumed(env, env.location, () => started++);
  expect(res.outcome).toBe("success");
  expect(started).toBe(1);
});
