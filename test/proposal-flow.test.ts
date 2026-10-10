import { expect, test } from "bun:test";
import {
  expireStaleProposals,
  PROPOSAL_NOTICE,
  postProposalNotices,
} from "../src/lifecycle/proposal-notices";
import {
  PROPOSAL_EXPIRED_REPLY,
  pendingProposalFor,
} from "../src/orchestrator/dispatch/proposal-flow";
import { budgetHitMessage } from "../src/orchestrator/engine/budget";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { resolveCommand } from "../src/orchestrator/task-routing";
import { finishRun } from "../src/orchestrator/tasks/task-result";
import {
  getProposal,
  insertProposal,
  listPendingProposals,
  PROPOSAL_TTL_MS,
} from "../src/storage/proposal-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTask, setTaskSession } from "../src/storage/run-store";
import {
  addRepo,
  BRIEF,
  clearWorkspaces,
  delegatingQuery,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "t1",
  text,
});

/** Env with a managed clone, a handler whose Q&A agent delegates `BRIEF`, and every plan-stage run captured. */
function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addRepo(env.home, "repo");
  const stageRuns: any[] = [];
  const query = delegatingQuery([{ brief: BRIEF }], (a: any) => {
    stageRuns.push(a.options);
    return (async function* () {
      yield resultMsg();
    })();
  });
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: query as never,
    approvals: stubGateway(),
  });
  return { env, handle, stageRuns };
}

test("DelegateTask: proposal row persisted after the Q&A turn, dispatched with the task; class kept on both", async () => {
  const { env, handle, stageRuns } = setup();
  await handle(msg("[design] fix it"));
  const [p] = env.db.query<any, []>("SELECT * FROM proposals").all();
  expect(p).toMatchObject({
    thread_id: "t1",
    workspace: "main",
    role: "dev",
    class: "design",
    status: "dispatched",
  });
  expect(p.from_task_id).toBeString();
  expect(p.decided_at).toBeNumber();
  const tasks = env.db
    .query<any, []>("SELECT id, type, class, proposal_id FROM tasks ORDER BY type DESC")
    .all();
  expect(tasks.map((t) => [t.type, t.class])).toEqual([
    ["qa", "design"],
    ["code", "design"],
  ]);
  expect(tasks[1].proposal_id).toBe(p.id);
  expect(tasks[0].id).toBe(p.from_task_id);
  expect(stageRuns).toHaveLength(1); // the plan stage ran
});

test("`go` starts a pending proposal that survived a restart; a second `go` is plain text", async () => {
  const { env, handle, stageRuns } = setup();
  const id = insertProposal(env.db, {
    threadId: "t1",
    workspace: "main",
    role: "dev",
    brief: BRIEF,
    class: "mechanical",
  });
  const reply = await handle(msg("go"));
  expect(reply).toContain("Starting plan");
  expect(getProposal(env.db, id)?.status).toBe("dispatched");
  expect(stageRuns).toHaveLength(1);
  expect(stageRuns[0].permissionMode).toBe("plan");
  expect(env.db.query("SELECT type, class, proposal_id FROM tasks").all()).toEqual([
    { type: "code", class: "mechanical", proposal_id: id },
  ]);
  // Nothing pending now: "go" is an ordinary message (a Q&A run; this fake agent delegates again, so the
  // new proposal comes from a Q&A task and the first one is not touched).
  await handle(msg("go"));
  const rows = env.db
    .query<any, []>("SELECT id, from_task_id FROM proposals ORDER BY created_at, rowid")
    .all();
  expect(rows).toHaveLength(2);
  expect(rows[0].from_task_id).toBeNull();
  expect(rows[1].from_task_id).toBeString();
});

test("`go` in another thread does not start this thread's proposal", async () => {
  const { env, handle } = setup();
  const id = insertProposal(env.db, {
    threadId: "other",
    workspace: "main",
    role: "dev",
    brief: BRIEF,
  });
  await handle(msg("go"));
  expect(getProposal(env.db, id)?.status).toBe("pending"); // "go" here was a plain Q&A message
});

test("startup: stale proposals expire, the notice goes once per thread with a pending one", async () => {
  const { env } = setup();
  const old = insertProposal(
    env.db,
    { threadId: "a", workspace: "main", role: "dev", brief: BRIEF },
    Date.now() - PROPOSAL_TTL_MS - 1000,
  );
  insertProposal(env.db, { threadId: "b", workspace: "main", role: "dev", brief: BRIEF });
  insertProposal(env.db, { threadId: "b", workspace: "main", role: "dev", brief: BRIEF });
  expect(expireStaleProposals(env.db)).toBe(1);
  expect(getProposal(env.db, old)?.status).toBe("expired");
  expect(listPendingProposals(env.db)).toHaveLength(2);
  const sent: Array<[string, string]> = [];
  const client: any = {
    channels: {
      fetch: async (id: string) => ({
        isSendable: () => true,
        send: async (m: any) => sent.push([id, m.content]),
      }),
    },
  };
  expect(await postProposalNotices({ db: env.db, getClient: () => client })).toBe(1);
  expect(sent).toEqual([["b", PROPOSAL_NOTICE]]);
  expect(PROPOSAL_NOTICE).toContain("reply `go`");
});

/** A thread whose last task ended on its budget (status failed, last run max_budget) with a saved session. */
function budgetStopped(env: ReturnType<typeof makeEnv>) {
  insertTask(env.db, { id: "tb", threadId: "t1", source: "s", repo: "repo", role: "assistant" });
  setTaskSession(env.db, "tb", "sess-b", env.repo);
  insertRun(env.db, {
    id: "rb",
    taskId: "tb",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1,
    turns: 1,
    durationMs: 1,
    outcome: "max_budget",
    compactions: 0,
  });
  env.db.query("UPDATE tasks SET status = 'failed' WHERE id = 'tb'").run();
}

test("go +<usd> resumes a budget-stopped task; plain resume is refused with the go + hint", () => {
  const env = makeEnv();
  budgetStopped(env);
  const deps = {
    db: env.db,
    agentHome: env.home,
    workspace: "main",
    repos: [{ name: "repo", path: env.repo } as any],
  };
  const plain = resolveCommand(deps, { kind: "resume" }, "t1");
  expect(plain).toMatchObject({ reason: "budget_stop" });
  const raised = resolveCommand(deps, { kind: "resume", extraBudgetUsd: 1.5 }, "t1");
  expect("reply" in raised).toBe(false);
  expect((raised as any).existing.session_id).toBe("sess-b");
});

test("a budget stop offers `go +<usd>`; the message helper keeps the hint", () => {
  const env = makeEnv();
  insertTask(env.db, { id: "t", threadId: "t1", source: "s", repo: "r", role: "assistant" });
  const text = finishRun(
    env.db,
    { taskId: "t", threadId: "t1" },
    {
      text: "x",
      outcome: "max_budget",
      sessionId: undefined,
      budgetUsd: 1.5,
      usage: { costUsd: 1.6 } as any,
    },
  );
  expect(text).toContain("`go +1.5`");
  expect(budgetHitMessage({ spentUsd: 1, limitUsd: 1 })).not.toContain("go +");
});

test("go +<usd> reaches the run: the resumed Q&A run carries extraBudgetUsd in its budget", async () => {
  const env = makeEnv();
  budgetStopped(env);
  const seen: any[] = [];
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: ((a: any) => {
      seen.push(a.options);
      return (async function* () {
        yield resultMsg();
      })();
    }) as never,
  });
  await handle(msg("go +2"));
  expect(seen).toHaveLength(1);
  expect(seen[0].maxBudgetUsd).toBeGreaterThanOrEqual(2);
  expect(seen[0].resume).toBe("sess-b");
});

test("use-time TTL: pendingProposalFor expires an old pending proposal (fake clock); go replies to re-send", async () => {
  const { env, handle } = setup();
  const t0 = Date.now();
  const id = insertProposal(
    env.db,
    { threadId: "t1", workspace: "main", role: "dev", brief: BRIEF },
    t0,
  );
  expect(pendingProposalFor(env.db, "t1", "main", t0 + PROPOSAL_TTL_MS - 1000)).toMatchObject({
    id,
  });
  expect(pendingProposalFor(env.db, "t1", "main", t0 + PROPOSAL_TTL_MS + 1000)).toBe("expired");
  expect(getProposal(env.db, id)?.status).toBe("expired");
  expect(pendingProposalFor(env.db, "t1", "main", t0 + PROPOSAL_TTL_MS + 2000)).toBeNull();
  // The `go` path: a proposal created 25h ago is expired, nothing starts.
  const old = insertProposal(
    env.db,
    { threadId: "t1", workspace: "main", role: "dev", brief: BRIEF },
    Date.now() - PROPOSAL_TTL_MS - 5000,
  );
  expect(await handle(msg("go"))).toBe(PROPOSAL_EXPIRED_REPLY);
  expect(getProposal(env.db, old)?.status).toBe("expired");
});
