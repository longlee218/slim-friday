import { expect, test } from "bun:test";
import { workspacePaths } from "../src/config/workspace-paths";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentClassifier, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import {
  QUEUE_RECEIVED,
  SIDE_BUSY,
  STEER_RECEIVED,
  STEER_WAITING,
} from "../src/orchestrator/thread/intent-replies";
import { deriveThreadState } from "../src/orchestrator/thread/thread-state";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { STATUS_HEADING } from "../src/orchestrator/turns/status-snapshot";
import { ROLES } from "../src/roles/role-registry";
import { decideApproval, insertApproval } from "../src/storage/approval-store";
import { listRunMessages } from "../src/storage/run-message-store";
import { insertToolCall } from "../src/storage/run-metrics-store";
import { setTurnStatus } from "../src/storage/run-store";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  clearWorkspaces,
  defaultLocationPath,
  initMsg,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/* The busy lane (Rev 11 review fixes): per-thread order of busy messages (H-a), the side lane for a foreground
   role (H-b), the plan question and typed feedback (H-c), the immediate ack (M-d). A fake CLI keeps a dev run
   (streaming, steerable) running until the test releases it. */

/** Env with one managed clone `real` (dev tasks need it). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  return env;
}

const msg = (text: string, extra: object = {}) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
  ...extra,
});

/** Everything the fake CLI and the fake L3 saw, in order. */
interface Probe {
  /** User messages the dev run pulled from its input. */
  pulled: string[];
  /** "l3:<text>" and "ack" in the order they happened. */
  events: string[];
  /** Options of every read-only (side) run. */
  sideOptions: Record<string, any>[];
  /** Highest number of queries running at the same moment. */
  maxConcurrent: number;
  /** Answers the owner gave to the dev run's plan question. */
  answers: string[];
}

/** L3: `ask` = a question (assistant, independent), `other` = a NEW dev task, `slow` waits first, `yes` reads as a yes. */
const classifier = (p: Probe): IntentClassifier => ({
  classify: async (i): Promise<IntentResult> => {
    p.events.push(`l3:${i.text}`);
    if (i.text.includes("slow")) await Bun.sleep(150);
    const base = { confidence: "high" as const, reason: "r" };
    if (i.text.includes("ask")) return { ...base, role: "assistant", scope: "new" };
    // a question about the running work: the model calls it a supplement (scope active), the table must still side-lane it
    if (i.text.includes("status")) return { ...base, role: "assistant", scope: "active" };
    const dev = {
      ...base,
      role: "dev",
      scope: i.text.includes("other") ? "new" : "active",
    } as const;
    return i.text === "yes" ? { ...dev, pendingAnswer: "yes" } : dev;
  },
});

/**
 * Harness: a dev task whose run works until `release()`. `steersToRead` = how many steers the run pulls after the
 * release. With `gate: true` the run asks the owner to approve its plan (AskUserQuestion) and, once the owner chose
 * "Revise", reads the typed feedback (a steer, delivered after the decision) and ends.
 */
async function harness(o: { steersToRead?: number; gate?: boolean; limit?: number } = {}) {
  const env = await setup();
  const p: Probe = { pulled: [], events: [], sideOptions: [], maxConcurrent: 0, answers: [] };
  let running = 0;
  let started!: () => void;
  const devStarted = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let decide: ((label: string) => void) | undefined;
  let asked = 0;
  let devRuns = 0;
  const query = (a: any) =>
    (async function* () {
      running++;
      p.maxConcurrent = Math.max(p.maxConcurrent, running);
      try {
        const o2 = a.options;
        if (o2.permissionMode !== "bypassPermissions") {
          // a read-only answering run (the side lane, or a queued question)
          p.sideOptions.push(o2);
          yield { ...initMsg, session_id: "side-sess" } as never;
          yield resultMsg({ result: "assistant answer", session_id: "side-sess" });
          return;
        }
        const it = a.prompt[Symbol.asyncIterator]();
        p.pulled.push((await it.next()).value.message.content);
        yield { ...initMsg, session_id: "main-sess" } as never;
        started();
        if (o.gate) {
          if (++devRuns > 1) {
            // a queued dev task started after the first one ended: it asks nothing and reads no steer
            yield resultMsg({ result: "queued task done", session_id: "q-sess" });
            return;
          }
          const r = await o2.canUseTool(
            ASK_USER_QUESTION_TOOL_NAME,
            {
              questions: [
                {
                  question: "Plan: add b. Approve?",
                  options: [{ label: "Approve" }, { label: "Revise" }],
                },
              ],
            },
            {},
          );
          p.answers.push(r.updatedInput.answers["Plan: add b. Approve?"]);
          for (let n = 0; n < (o.steersToRead ?? 0); n++) {
            const steer = (await it.next()).value.message.content as string; // the typed feedback
            p.pulled.push(steer);
            yield {
              type: "user",
              isReplay: true,
              message: { role: "user", content: steer },
            } as never;
          }
          yield resultMsg({ result: "plan revised", session_id: "main-sess" });
          return;
        }
        await released;
        for (let n = 0; n < (o.steersToRead ?? 0); n++) {
          const steer = (await it.next()).value.message.content as string;
          p.pulled.push(steer);
          yield {
            type: "user",
            isReplay: true,
            message: { role: "user", content: steer },
          } as never;
        }
        yield resultMsg({ result: "plan text", session_id: "main-sess" });
      } finally {
        running--;
      }
    })();
  const approvals = stubGateway({
    // The plan question: the approval row + waiting status are what the thread state derives from.
    askChoice: async (a) => {
      if (asked >= 1) return a.options[0]; // a queued task: not this test's question
      insertApproval(env.db, {
        id: `ap${++asked}`,
        turnId: a.turnId,
        tool: ASK_USER_QUESTION_TOOL_NAME,
        summary: a.question,
      });
      setTurnStatus(env.db, a.turnId, "waiting_approval");
      const label = await new Promise<string>((res) => (decide = res));
      decideApproval(env.db, `ap${asked}`, "approved");
      setTurnStatus(env.db, a.turnId, "running");
      return label;
    },
  });
  const intent: IntentDeps = {
    pipeline: {
      lexicon: loadLexicon(env.home),
      tagRouter: createRoleTagRouter(Object.values(ROLES)),
    },
    classifier: classifier(p),
  };
  const limiter = createRunLimiter(o.limit ?? 5);
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals,
    queryFn: query as never,
    intent,
    limiter,
  });
  /** Start the dev task and wait until its run works (and, with a gate, until the plan question waits). */
  const start = async () => {
    const first = handle(msg("please add b.txt with two"));
    await devStarted;
    if (o.gate) while (deriveThreadState(env.db, "th1") !== "awaiting_owner") await Bun.sleep(5);
    return { first, answer: (label: string) => decide?.(label) };
  };
  return { env, p, handle, start, release, limiter };
}

const queuedBriefs = (env: { db: ReturnType<typeof makeEnv>["db"] }) =>
  env.db
    .query<{ brief: string }, []>(
      "SELECT brief FROM proposals WHERE status = 'queued' ORDER BY created_at, rowid",
    )
    .all()
    .map((r) => r.brief.split("\n")[0]);

test("H-a: busy messages are decided one after the other in arrival order, whatever the L3 latency (steers)", async () => {
  const h = await harness({ steersToRead: 2 });
  const { first } = await h.start();
  // A is slow in L3, B is fast: B must NOT overtake A
  const a = h.handle(msg("slow also A"));
  const b = h.handle(msg("also B"));
  expect(await Promise.all([a, b])).toEqual([STEER_RECEIVED, STEER_RECEIVED]);
  expect(
    h.p.events.filter((e) => e.startsWith("l3:") && e !== "l3:please add b.txt with two"),
  ).toEqual(["l3:slow also A", "l3:also B"]);
  h.release();
  await first;
  expect(h.p.pulled.slice(1)).toEqual(["slow also A", "also B"]); // the run read them in arrival order
  const rows = listRunMessages(h.env.db, "th1");
  expect(rows.map((r) => [r.seq, r.content])).toEqual([
    [1, "slow also A"],
    [2, "also B"],
  ]);
});

test("H-a: independent messages queue in arrival order too (uneven L3 latency)", async () => {
  const h = await harness();
  const { first } = await h.start();
  const x = h.handle(msg("slow other X"));
  const y = h.handle(msg("other Y"));
  expect(await Promise.all([x, y])).toEqual([QUEUE_RECEIVED, QUEUE_RECEIVED]);
  expect(queuedBriefs(h.env)).toEqual(["slow other X", "other Y"]);
  expect(listRunMessages(h.env.db, "th1").map((r) => r.content)).toEqual([
    "slow other X",
    "other Y",
  ]);
  h.release();
  await first;
});

test("M-d: the ack comes at once, before L3 reads the message (and a failing ack changes nothing)", async () => {
  const h = await harness({ steersToRead: 1 });
  const { first } = await h.start();
  const ack = async () => void h.p.events.push("ack");
  expect(await h.handle(msg("slow also A", { ack }))).toBe(STEER_RECEIVED);
  expect(h.p.events.slice(-2)).toEqual(["ack", "l3:slow also A"]);
  const broken = async () => {
    throw new Error("missing permission");
  };
  expect(await h.handle(msg("also B", { ack: broken }))).toBe(STEER_RECEIVED);
  h.release();
  await first;
});

test("H-b side lane: an independent question is answered at once, in parallel with the running task, without its session, lock or thread rows", async () => {
  const h = await harness({ steersToRead: 1 });
  const { first } = await h.start();
  const state = () => deriveThreadState(h.env.db, "th1");
  expect(state()).toBe("running");
  // answered while the task is still running (the dev run has not been released)
  expect(await h.handle(msg("ask: what does a.txt hold"))).toBe("assistant answer");
  expect(h.p.maxConcurrent).toBe(2); // task + side run at the same time
  // the side run started fresh: no resume, no steer input (a string prompt)
  expect(h.p.sideOptions).toHaveLength(1);
  expect(h.p.sideOptions[0]?.resume).toBeUndefined();
  expect(h.env.db.query("SELECT 1 FROM sessions WHERE thread_id = 'th1'").get()).toBeNull();
  // the thread's own rows are untouched: one running dev task; the side row lives under another thread id
  expect(state()).toBe("running");
  expect(h.env.db.query("SELECT role, status FROM turns WHERE thread_id = 'th1'").all()).toEqual([
    { role: "dev", status: "running" },
  ]);
  expect(
    h.env.db.query("SELECT role, status FROM turns WHERE thread_id = 'th1:side'").all(),
  ).toEqual([{ role: "assistant", status: "done" }]);
  // the lock is the task's: its steer input still takes messages (the side run did not register a sink or free the lock)
  expect(await h.handle(msg("also keep it small"))).toBe(STEER_RECEIVED);
  expect(h.limiter.active()).toBe(1); // the side run released its slot
  h.release();
  await first;
  // the thread's session is the task's, never the side answer's
  expect(
    h.env.db
      .query<{ session_id: string }, []>("SELECT session_id FROM sessions WHERE thread_id = 'th1'")
      .get()?.session_id ?? "main-sess",
  ).toBe("main-sess");
  expect(listRunMessages(h.env.db, "th1").map((r) => [r.kind, r.status])).toEqual([
    ["other", "delivered"],
    ["steer", "delivered"],
  ]);
});

test("H-b side lane: the global run limiter is respected (full = a clear busy reply, no run)", async () => {
  const h = await harness({ limit: 1 });
  const { first } = await h.start();
  expect(await h.handle(msg("ask: what does a.txt hold"))).toBe(SIDE_BUSY(1));
  expect(h.p.sideOptions).toHaveLength(0);
  h.release();
  await first;
});

test("H-b side lane: a side run that starts after the thread was stopped is aborted at once", async () => {
  const h = await harness();
  const { first } = await h.start();
  // L3 of the question is slow: `/stop` lands while it decides, so the side run starts with an aborted thread
  const side = h.handle(msg("slow ask: what does a.txt hold"));
  await Bun.sleep(20);
  await h.handle(msg("/stop"));
  await side;
  expect(h.p.sideOptions).toHaveLength(1);
  expect(h.p.sideOptions[0]?.abortController.signal.aborted).toBe(true);
  h.release();
  await first;
});

test("H-c plan question: typed feedback is a steer delivered after the decision; questions use the side lane; other work queues; a typed yes does not approve; every message is stored", async () => {
  const h = await harness({ gate: true, steersToRead: 2 });
  const { first, answer } = await h.start();
  const waiting = STEER_WAITING(ASK_USER_QUESTION_TOOL_NAME);
  expect(deriveThreadState(h.env.db, "th1")).toBe("awaiting_owner");
  // a question for the assistant: answered at once, the plan question stays open
  expect(await h.handle(msg("ask: why that location"))).toBe("assistant answer");
  expect(deriveThreadState(h.env.db, "th1")).toBe("awaiting_owner");
  // independent background work waits for the task
  expect(await h.handle(msg("other: add c.txt"))).toBe(QUEUE_RECEIVED);
  // a typed yes does not approve (the buttons do): it is stored as a steer for after the decision
  expect(await h.handle(msg("yes"))).toBe(waiting);
  // feedback on the plan: typed text, a steer too
  expect(await h.handle(msg("make the plan smaller"))).toBe(waiting);
  answer("Revise"); // the owner presses "Revise"
  const reply = await first;
  expect(h.p.answers).toEqual(["Revise"]);
  expect(h.p.pulled.slice(1, 3)).toEqual(["yes", "make the plan smaller"]); // read after the decision, in order
  expect(reply).toContain("plan revised");
  expect(listRunMessages(h.env.db, "th1").map((r) => [r.kind, r.status])).toEqual([
    ["other", "delivered"], // side question
    ["followup", "delivered"], // queued
    ["steer", "delivered"], // the yes
    ["steer", "delivered"], // the feedback
  ]);
});

/** The id of the thread's running task. */
const liveTaskId = (env: { db: ReturnType<typeof makeEnv>["db"] }) =>
  env.db.query<{ id: string }, []>("SELECT id FROM turns WHERE thread_id = 'th1'").get()!.id;

test("B: a steer while a tool approval waits gets the waiting reply (tool name), is stored pending and is delivered after the decision", async () => {
  const h = await harness({ steersToRead: 1 });
  const { first } = await h.start();
  const taskId = liveTaskId(h.env);
  insertApproval(h.env.db, { id: "tool1", turnId: taskId, tool: "Bash", summary: "cd x && ls" });
  setTurnStatus(h.env.db, taskId, "waiting_approval");
  expect(deriveThreadState(h.env.db, "th1")).toBe("awaiting_owner");
  const reply = await h.handle(msg("also keep it small"));
  expect(reply).toBe(STEER_WAITING("Bash"));
  expect(reply).not.toContain("read");
  // stored at once as a steer, not yet read by the run
  expect(listRunMessages(h.env.db, "th1").map((r) => [r.kind, r.status, r.content])).toEqual([
    ["steer", "pending", "also keep it small"],
  ]);
  // the owner decides: the run goes on and reads it
  decideApproval(h.env.db, "tool1", "approved");
  setTurnStatus(h.env.db, taskId, "running");
  expect(deriveThreadState(h.env.db, "th1")).toBe("running");
  h.release();
  await first;
  expect(h.p.pulled.slice(1)).toEqual(["also keep it small"]);
  expect(listRunMessages(h.env.db, "th1").map((r) => r.status)).toEqual(["delivered"]);
});

test("C: a foreground role on a busy thread goes to the side lane even when L3 says supplement; the answer sees the status snapshot (fields only, no tool input)", async () => {
  const h = await harness({ steersToRead: 0 });
  const { first } = await h.start();
  const taskId = liveTaskId(h.env);
  // a finished tool call of the running task (a running task has no `runs` row yet) and a pending tool approval
  insertToolCall(h.env.db, {
    id: "tc1",
    runId: "run-live",
    turnId: taskId,
    tool: "Grep",
    inputJson: '{"pattern":"sk-ant-api03-SECRETSECRETSECRET"}',
    outputPreview: "hit",
    isError: false,
    durationMs: 3,
  });
  insertApproval(h.env.db, { id: "tool1", turnId: taskId, tool: "Bash", summary: "ls" });
  setTurnStatus(h.env.db, taskId, "waiting_approval");
  expect(await h.handle(msg("status? what is the agent doing"))).toBe("assistant answer");
  expect(h.p.sideOptions).toHaveLength(1);
  const seen = JSON.stringify({ ...h.p.sideOptions[0], mcpServers: undefined }); // the in-process server instance is cyclic
  expect(seen).toContain(STATUS_HEADING);
  expect(seen).toContain("state: awaiting_owner");
  expect(seen).toContain("last tool: Grep");
  expect(seen).toContain("waiting for the owner's approval of Bash");
  expect(seen).toContain("role dev");
  expect(seen).not.toContain("SECRETSECRET");
  // nothing was steered into the run
  expect(listRunMessages(h.env.db, "th1").map((r) => [r.kind, r.status])).toEqual([
    ["other", "delivered"],
  ]);
  h.release();
  await first;
  expect(h.p.pulled).toHaveLength(1); // only the task's own first message
});

test("C: a dev supplement on the same busy thread still steers", async () => {
  const h = await harness({ steersToRead: 1 });
  const { first } = await h.start();
  expect(await h.handle(msg("also add a comment"))).toBe(STEER_RECEIVED);
  h.release();
  await first;
  expect(h.p.pulled.slice(1)).toEqual(["also add a comment"]);
});
