import { expect, test } from "bun:test";
import { dispatchRole } from "../src/orchestrator/dispatch/dispatch-role";
import { MAX_CAPPED_TASKS } from "../src/orchestrator/dispatch/task-location";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { listPendingProposals } from "../src/storage/proposal-store";
import { insertTurn } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  BRIEF,
  clearWorkspaces,
  defaultLocationPath,
  devIntent,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "T <t@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  return { env, locations: loadWorkspaces(env.home).workspaces[0]!.locations };
}

const task = {
  source: "t",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text: "x",
};
const rows = (env: { db: any }, sql: string) => env.db.query(sql).all() as any[];

/** Dispatcher deps whose runs would be captured (none must start in the refusal tests). */
const deps = (env: Awaited<ReturnType<typeof setup>>["env"], runs: unknown[]) => ({
  db: env.db,
  config: env.config,
  approvals: stubGateway(),
  queryFn: ((a: unknown) => {
    runs.push(a);
    return (async function* () {})();
  }) as never,
  stopping: () => false,
});

test("ordering: the proposal is persisted and validated before the dev run starts; no assistant turn first", async () => {
  const { env } = await setup();
  const events: string[] = [];
  const query = (a: any) => {
    // A run = dispatch happened: the proposal row must already exist.
    events.push(
      `run ${a.options.permissionMode} proposals=${rows(env, "SELECT 1 FROM proposals").length}`,
    );
    return (async function* () {
      yield resultMsg();
    })();
  };
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: query as never,
    intent: devIntent(env.home),
  });
  await handle({ ...task, text: "[dev] add a file with the answer" });
  expect(events).toEqual(["run bypassPermissions proposals=1"]);
  expect(rows(env, "SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
});

test("ask rule: unknown location -> ONE question, proposal stays pending, no task row, no run", async () => {
  const { env, locations } = await setup();
  const runs: unknown[] = [];
  const reply = await dispatchRole(deps(env, runs), {
    request: { role: "dev", brief: BRIEF, location: "nope" },
    message: task,
    reply: "Q&A answer",
    workspace: "main",
    locations,
    ac: new AbortController(),
  });
  expect(reply).toContain("Q&A answer");
  expect(reply).toContain("I could not find the location");
  expect(listPendingProposals(env.db)).toHaveLength(1);
  expect(rows(env, "SELECT 1 FROM turns")).toEqual([]);
  expect(runs).toEqual([]);
});

test("refusal (cap full): proposal refused, reply says busy, nothing starts", async () => {
  const { env, locations } = await setup();
  for (const id of Array.from({ length: MAX_CAPPED_TASKS }, (_, n) => `cap${n}`))
    insertTurn(env.db, { id, threadId: id, source: "t", location: "real", role: "dev" });
  const runs: unknown[] = [];
  const reply = await dispatchRole(deps(env, runs), {
    request: { role: "dev", brief: BRIEF },
    message: task,
    reply: "",
    workspace: "main",
    locations,
    ac: new AbortController(),
  });
  expect(reply).toMatch(/handling other work|đang xử lý việc khác/);
  expect(rows(env, "SELECT status, role FROM proposals")).toEqual([
    { status: "refused", role: "dev" },
  ]);
  expect(runs).toEqual([]);
});

test("owner `go` on a pending proposal: confirmed, re-validated, dispatched with parent + hop", async () => {
  const { env, locations } = await setup();
  const runs: any[] = [];
  const d = deps(env, runs);
  // Low confidence: asked once, stays pending ...
  const first = await dispatchRole(d, {
    request: { role: "dev", brief: BRIEF, confidence: 0.1 },
    message: task,
    reply: "",
    workspace: "main",
    locations,
    ac: new AbortController(),
  });
  expect(first).toContain("Would you like me to carry out");
  const [p] = listPendingProposals(env.db);
  expect(p!.confidence).toBeCloseTo(0.1);
  // ... then `go` (confirmed) starts it and marks it dispatched.
  await dispatchRole(d, {
    request: {
      role: p!.role,
      brief: p!.brief,
      confidence: 0.1,
      proposalId: p!.id,
      confirmed: true,
    },
    message: task,
    reply: "",
    workspace: "main",
    locations,
    ac: new AbortController(),
    fromTurnId: "src-task",
  });
  expect(runs).toHaveLength(1); // the dev run ran
  expect(rows(env, "SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
  expect(rows(env, "SELECT role, kind, parent_turn_id, hop, proposal_id FROM turns")).toEqual([
    { role: "dev", kind: "single", parent_turn_id: "src-task", hop: 1, proposal_id: p!.id },
  ]);
});

test("new ask supersedes the thread's older pending proposals; go on an invalid proposal replies once and refuses it", async () => {
  const { env, locations } = await setup();
  const runs: unknown[] = [];
  const d = deps(env, runs);
  const send = (request: any) =>
    dispatchRole(d, {
      request,
      message: task,
      reply: "",
      workspace: "main",
      locations,
      ac: new AbortController(),
    });
  await send({ role: "dev", brief: BRIEF, location: "nope" });
  await send({ role: "dev", brief: BRIEF, location: "nope2" });
  const pending = listPendingProposals(env.db);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.location).toBe("nope2");
  expect(rows(env, "SELECT status FROM proposals ORDER BY created_at, rowid")).toEqual([
    { status: "expired" },
    { status: "pending" },
  ]);
  // `go` (proposalId set, confirmed) still fails validation: one reply, then it is final (no loop).
  const p = pending[0]!;
  const reply = await send({
    role: p.role,
    brief: p.brief,
    location: "nope2",
    proposalId: p.id,
    confirmed: true,
  });
  expect(reply).toContain("I could not find the location");
  expect(listPendingProposals(env.db)).toEqual([]);
  expect(rows(env, "SELECT status FROM proposals WHERE id = ?".replace("?", `'${p.id}'`))).toEqual([
    { status: "refused" },
  ]);
  expect(runs).toEqual([]);
});

test("a proposal that is no longer pending is never started twice", async () => {
  const { env, locations } = await setup();
  const runs: unknown[] = [];
  const d = deps(env, runs);
  await dispatchRole(d, {
    request: { role: "dev", brief: BRIEF, confidence: 0.1 },
    message: task,
    reply: "",
    workspace: "main",
    locations,
    ac: new AbortController(),
  });
  const [p] = listPendingProposals(env.db);
  env.db.query("UPDATE proposals SET status = 'dispatched' WHERE id = ?").run(p!.id);
  const reply = await dispatchRole(d, {
    request: { role: "dev", brief: BRIEF, proposalId: p!.id, confirmed: true },
    message: task,
    reply: "",
    workspace: "main",
    locations,
    ac: new AbortController(),
  });
  expect(reply).toContain("no longer waiting");
  expect(runs).toEqual([]);
});
