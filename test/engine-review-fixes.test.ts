import { expect, test } from "bun:test";
import { TASK_BUDGET_USD } from "../src/config/model-routing";
import { runRole } from "../src/orchestrator/run/run-role";
import { finishRun } from "../src/orchestrator/turns/turn-result";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import { addLocation, clearWorkspaces, makeEnv, resultMsg, stubGateway } from "./helpers";

/** One finished run row of `turnId` that cost `costUsd`. */
/** Turn `id` continues `parent` (kind `resume`): the task ceiling is shared along that chain. `insertTurn` no longer writes it. */
function asResume(db: ReturnType<typeof makeEnv>["db"], id: string, parent: string): void {
  db.query("UPDATE turns SET kind = 'resume', parent_turn_id = ? WHERE id = ?").run(parent, id);
}

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
      role: "developer",
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
  insertTurn(env.db, {
    id: "t1",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  insertTurn(env.db, {
    id: "t2",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  asResume(env.db, "t2", "t1");
  insertTurn(env.db, {
    id: "t3",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  asResume(env.db, "t3", "t2");
  // An unrelated task of the same thread does not count.
  insertTurn(env.db, {
    id: "other",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  spend(env.db, "t1", 4.0);
  spend(env.db, "t2", 1.5);
  spend(env.db, "other", 5.0);
  const { res, seen } = await runDev(env, "t3");
  expect(res.outcome).toBe("success");
  expect(seen[0].maxBudgetUsd).toBeCloseTo(0.5);
  expect(res.ceilingBound).toBe(true); // the cap IS the ceiling: the raise is impossible
});

test("task ceiling used up: the run is refused before it starts, it cannot be raised", async () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  insertTurn(env.db, {
    id: "t1",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  insertTurn(env.db, {
    id: "t2",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  asResume(env.db, "t2", "t1");
  spend(env.db, "t1", TASK_BUDGET_USD);
  const { res, seen } = await runDev(env, "t2");
  expect(res.outcome).toBe("error");
  expect(res.text).toContain("cannot be raised");
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
  insertTurn(env.db, {
    id: "t1",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  insertTurn(env.db, {
    id: "t2",
    threadId: "th",
    source: "t",
    location: "location",
    role: "developer",
  });
  env.db.query("UPDATE turns SET parent_turn_id = ? WHERE id = ?").run("t1", "t2"); // a hop, not a resume
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
    role: "lead",
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
      role: "lead",
      workspace: "main",
      locations: [{ name: "location", path: env.location } as never],
      ac: new AbortController(),
    },
  );
  await run.catch(() => undefined);
  expect(env.db.query("SELECT outcome FROM runs").all()).toEqual([{ outcome: "error" }]);
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
      role: "developer",
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
