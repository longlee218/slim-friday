import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import type { IntentDeps } from "../src/intent/decide-intent";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { captureLogs, logger } from "../src/observability/logger";
import { continueOwnedTask } from "../src/orchestrator/dispatch/continue-owned-task";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { ROLES } from "../src/roles/role-registry";
import type { RouteProposer } from "../src/intent/jev/route-proposer";
import { activeOwnedTask, getOwnedTask, ownedTaskOfTurn } from "../src/storage/owned-task-store";
import { interruptRunningTurns, setTurnSession } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  clearWorkspaces,
  DEV_REQUEST,
  defaultLocationPath,
  initMsg,
  makeEnv,
  promptText,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

const BG = Object.values(ROLES).find((r) => r.background)!.name;

/** An env with one registered real git repo `real` and a thread whose dev run was cut short (task waits for the owner). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  return {
    env,
    clone,
    locations: loadWorkspaces(env.home).workspaces.find((w) => w.name === "main")?.locations ?? [],
  };
}

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

test("continueOwnedTask: session plan in the task's own cwd with the owner text; undefined without a usable session", async () => {
  const { env, clone, locations } = await setup();
  beginTurn(
    env.db,
    logger,
    { turnId: "t1", threadId: "th1", source: "t" },
    { location: "real", role: BG },
  );
  interruptRunningTurns(env.db);
  const task = activeOwnedTask(env.db, "th1")!;
  const deps = { db: env.db, locations, threadId: "th1" };
  // No session recorded yet.
  expect(continueOwnedTask(deps, task, "go on")).toBeUndefined();
  setTurnSession(env.db, "t1", "sess-1", realpathSync(clone));
  const plan = continueOwnedTask(deps, task, "go on")!;
  expect(plan.cmd).toEqual({ kind: "message", role: BG, text: "go on" });
  expect(plan.resume).toEqual({ sessionId: "sess-1", cwd: realpathSync(clone), of: "t1" });
  expect(plan.existing).toMatchObject({ session_id: "sess-1", location: "real", thread_id: "th1" });
  // Empty text and a cwd that is not a registered location are refused.
  expect(continueOwnedTask(deps, task, "")).toBeUndefined();
  setTurnSession(env.db, "t1", "sess-1", env.home);
  expect(continueOwnedTask(deps, task, "go on")).toBeUndefined();
});

/** Handler with engine `jev`: the proposer says `continue`; Haiku (L3) must stay unused. */
async function handler(steps: ("error" | "ok")[]) {
  const { env, clone } = await setup();
  const seen: any[] = [];
  let l3 = 0;
  let n = 0;
  const proposer: RouteProposer = { propose: async () => ({ kind: "continue" }) };
  const intent: IntentDeps = {
    pipeline: {
      lexicon: loadLexicon(env.home),
      tagRouter: createRoleTagRouter(Object.values(ROLES)),
    },
    classifier: {
      classify: async () => {
        l3++;
        return { role: "assistant", scope: "new", confidence: "high", reason: "r" };
      },
    },
    engine: "jev",
    proposer,
  };
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    intent,
    queryFn: ((a: any) =>
      (async function* () {
        a.promptText = await promptText(a.prompt);
        seen.push(a);
        const step = steps[n++] ?? "ok";
        yield { ...initMsg, session_id: `sess-${n}` } as never;
        yield step === "error"
          ? resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })
          : resultMsg({ result: "Xong\n\nlocation: real", session_id: `sess-${n}` });
      })()) as never,
  });
  return { env, clone, seen, handle, l3: () => l3 };
}

/** Every turn of the db in start order: its kind and the owned task it is linked to. */
const turnRows = (db: ReturnType<typeof makeEnv>["db"]) =>
  db
    .query<{ id: string; kind: string }, []>(
      "SELECT id, kind FROM turns ORDER BY started_at, rowid",
    )
    .all()
    .map((r) => ({ kind: r.kind, owned: ownedTaskOfTurn(db, r.id) }));

/** Run the dev task, then cut it short the way a restart does (no pending question, task waits for the owner). */
async function interrupted(h: Awaited<ReturnType<typeof handler>>) {
  await h.handle(msg(DEV_REQUEST));
  h.env.db.query("UPDATE turns SET status = 'interrupted'").run();
  const task = activeOwnedTask(h.env.db, "th1")!;
  expect(task.status).toBe("waiting_user");
  return task;
}

test("a plain follow-up the proposer marks `continue` resumes the waiting task's session with the owner text, same owned task, no L3", async () => {
  const h = await handler(["error", "ok"]);
  const task = await interrupted(h);
  const cap = captureLogs();
  const reply = await h.handle(msg("also cover the retry case please"));
  cap.stop();
  expect(reply).toContain("Xong");
  expect(h.l3()).toBe(0);
  expect(h.seen).toHaveLength(2);
  expect(h.seen[1].options.resume).toBe("sess-1");
  expect(h.seen[1].options.cwd).toBe(realpathSync(h.clone));
  expect(h.seen[1].promptText).toBe("also cover the retry case please");
  const rows = turnRows(h.env.db);
  expect(rows.map((r) => r.owned)).toEqual([task.taskId, task.taskId]);
  expect(rows[1]!.kind).toBe("resume");
  expect(h.env.db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 1 });
  const d = cap.lines.filter((l) => l.event === "route.decision");
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({
    source: "owner",
    rationaleCode: "CONTEXT_CONTINUATION",
    ownedTaskId: task.taskId,
    candidateAgentId: BG,
  });
  expect(getOwnedTask(h.env.db, task.taskId)?.status).toBe("waiting_user");
});

test("session gone: the owner role starts a fresh run through the normal path, linked to the same task", async () => {
  const h = await handler(["error", "ok"]);
  const task = await interrupted(h);
  h.env.db.query("UPDATE turns SET session_id = NULL, session_cwd = NULL").run();
  await h.handle(msg("also cover the retry case please"));
  expect(h.seen).toHaveLength(2);
  expect(h.seen[1].options.resume).toBeUndefined();
  const owned = turnRows(h.env.db).map((r) => r.owned);
  expect(owned).toEqual([task.taskId, task.taskId]);
});

test("the executor crashing still logs the message's one route.decision (source fallback)", async () => {
  const h = await handler(["ok"]);
  // The turn insert (inside the dispatcher, i.e. inside the executor) fails.
  h.env.db.transaction = (() => () => {
    throw new Error("db down");
  }) as never;
  const cap = captureLogs();
  await h.handle(msg(DEV_REQUEST));
  cap.stop();
  const d = cap.lines.filter((l) => l.event === "route.decision");
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ source: "fallback", candidateAgentId: BG, failed: true });
});
