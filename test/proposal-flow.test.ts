import { expect, test } from "bun:test";
import { renderUserNotice } from "../src/ingress/user-copy";
import {
  expireStaleProposals,
  PROPOSAL_NOTICE,
  postProposalNotices,
  QUEUED_NOTICE,
  releaseQueuedProposals,
} from "../src/lifecycle/proposal-notices";
import {
  PROPOSAL_EXPIRED_REPLY,
  pendingProposalFor,
} from "../src/orchestrator/dispatch/proposal-flow";
import { budgetHitMessage } from "../src/orchestrator/engine/budget";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { resolveCommand } from "../src/orchestrator/message-routing";
import { finishRun } from "../src/orchestrator/turns/turn-result";
import {
  getProposal,
  insertProposal,
  listPendingProposals,
  PROPOSAL_TTL_MS,
  setProposalStatus,
} from "../src/storage/proposal-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn, setTurnSession } from "../src/storage/run-store";
import {
  addLocation,
  BRIEF,
  clearWorkspaces,
  devIntent,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const msg = (text: string) => ({
  source: "t",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "t1",
  text,
});

/** Env with a managed clone, a handler with the intent layer (L0-L3), and every dev run captured. */
function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "location");
  const stageRuns: any[] = [];
  const query = (a: any) => {
    stageRuns.push(a.options);
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: query as never,
    approvals: stubGateway(),
    intent: devIntent(env.home),
  });
  return { env, handle, stageRuns };
}

test("intent: a dev request persists a proposal row, dispatched with the task; class kept", async () => {
  const { env, handle, stageRuns } = setup();
  await handle(msg("[design] [dev] fix it"));
  const [p] = env.db.query<any, []>("SELECT * FROM proposals").all();
  expect(p).toMatchObject({
    thread_id: "t1",
    workspace: "main",
    role: "dev",
    class: "design",
    status: "dispatched",
  });
  expect(p.from_turn_id).toBeNull(); // no source turn: the orchestrator wrote it from the owner message
  expect(p.decided_at).toBeNumber();
  const tasks = env.db.query<any, []>("SELECT type, class, proposal_id FROM turns").all();
  expect(tasks.map((t) => [t.type, t.class])).toEqual([["code", "design"]]);
  expect(tasks[0].proposal_id).toBe(p.id);
  expect(stageRuns).toHaveLength(1); // the dev run ran
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
  expect(reply).toContain("starting on your request");
  expect(getProposal(env.db, id)?.status).toBe("dispatched");
  expect(stageRuns).toHaveLength(1);
  expect(stageRuns[0].permissionMode).toBe("bypassPermissions");
  expect(env.db.query("SELECT type, class, proposal_id FROM turns").all()).toEqual([
    { type: "code", class: "mechanical", proposal_id: id },
  ]);
  // Nothing pending now: "go" is an ordinary message (no L4 here: the assistant answers); no new proposal.
  await handle(msg("go"));
  const rows = env.db.query<any, []>("SELECT id, status FROM proposals").all();
  expect(rows).toEqual([{ id, status: "dispatched" }]);
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
  // No pinned language or brief for the thread: the default (Vietnamese) notice.
  expect(sent).toEqual([
    ["b", renderUserNotice({ kind: "note", state: "proposal-pending" }, "vi")],
  ]);
  expect(PROPOSAL_NOTICE).toContain("reply `/go`");
});

/** A thread whose last task ended on its budget (status failed, last run max_budget) with a saved session. */
function budgetStopped(env: ReturnType<typeof makeEnv>) {
  insertTurn(env.db, {
    id: "tb",
    threadId: "t1",
    source: "s",
    location: "location",
    role: "assistant",
  });
  setTurnSession(env.db, "tb", "sess-b", env.location);
  insertRun(env.db, {
    id: "rb",
    turnId: "tb",
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
  env.db.query("UPDATE turns SET status = 'failed' WHERE id = 'tb'").run();
}

test("go +<usd> resumes a budget-stopped task; plain resume is refused with the go + hint", () => {
  const env = makeEnv();
  budgetStopped(env);
  const deps = {
    db: env.db,
    agentHome: env.home,
    workspace: "main",
    locations: [{ name: "location", path: env.location } as any],
  };
  const plain = resolveCommand(deps, { kind: "resume" }, "t1");
  expect(plain).toMatchObject({ reason: "budget_stop" });
  const raised = resolveCommand(deps, { kind: "resume", extraBudgetUsd: 1.5 }, "t1");
  expect("reply" in raised).toBe(false);
  expect((raised as any).existing.session_id).toBe("sess-b");
});

test("a budget stop offers `go +<usd>`; the message helper keeps the hint", () => {
  const env = makeEnv();
  insertTurn(env.db, { id: "t", threadId: "t1", source: "s", location: "r", role: "assistant" });
  const text = finishRun(
    env.db,
    { turnId: "t", threadId: "t1" },
    {
      text: "x",
      outcome: "max_budget",
      sessionId: undefined,
      budgetUsd: 1.5,
      usage: { costUsd: 1.6 } as any,
    },
    "en",
  );
  expect(text).toContain("`/go +1.5`");
  expect(budgetHitMessage({ spentUsd: 1, limitUsd: 1 }, "en")).not.toContain("go +");
});

test("go +<usd> reaches the run: the resumed Q&A run carries extraBudgetUsd in its budget", async () => {
  const env = makeEnv();
  budgetStopped(env);
  const seen: any[] = [];
  const handle = createTurnHandler({
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

test("startup: a queued proposal goes back to pending and gets its own notice", async () => {
  const env = makeEnv();
  const id = insertProposal(env.db, {
    threadId: "q",
    workspace: "main",
    role: "dev",
    brief: BRIEF,
  });
  setProposalStatus(env.db, id, "queued");
  const queuedThreads = releaseQueuedProposals(env.db);
  expect([...queuedThreads]).toEqual(["q"]);
  expect(getProposal(env.db, id)?.status).toBe("pending");
  const sent: Array<[string, string]> = [];
  const client: any = {
    channels: {
      fetch: async (tid: string) => ({
        isSendable: () => true,
        send: async (m: any) => sent.push([tid, m.content]),
      }),
    },
  };
  await postProposalNotices({ db: env.db, getClient: () => client, queuedThreads });
  expect(sent).toEqual([["q", renderUserNotice({ kind: "note", state: "proposal-queued" }, "vi")]]);
  expect(QUEUED_NOTICE).toContain("Queued request not started");
});
