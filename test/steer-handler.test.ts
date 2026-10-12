import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentClassifier, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { captureLogs } from "../src/observability/logger";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import {
  NOT_DELIVERED,
  QUEUE_RECEIVED,
  STEER_FULL,
  STEER_RECEIVED,
} from "../src/orchestrator/thread/intent-replies";
import { ROLES } from "../src/roles/role-registry";
import { listRunMessages } from "../src/storage/run-message-store";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  clearWorkspaces,
  initMsg,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/** Roles of the thread's queued proposals, oldest first. */
const queuedRoles = (db: ReturnType<typeof makeEnv>["db"]) =>
  db
    .query<{ role: string }, []>(
      "SELECT role FROM proposals WHERE status = 'queued' ORDER BY created_at, rowid",
    )
    .all()
    .map((r) => r.role);

/** Pending proposals (the open questions). */
const listPendingProposals = (db: ReturnType<typeof makeEnv>["db"]) =>
  db.query("SELECT id FROM proposals WHERE status = 'pending'").all();

/** Env with one managed clone `real` (dev tasks need it). */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
  await g(clone, "config", "user.email", "test@example.com");
  await g(clone, "config", "user.name", "t");
  return env;
}

const msg = (text: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "th1",
  text,
});

/** L3 verdicts by message text: `ask` = a question (assistant, independent), `other` = a NEW dev task, else a supplement of the running task. */
const classifier: IntentClassifier = {
  classify: async (i): Promise<IntentResult> => {
    const base = { confidence: "high" as const, reason: "r" };
    if (i.text.includes("ask")) return { ...base, role: "assistant", scope: "new" };
    return { ...base, role: "dev", scope: i.text.includes("other") ? "new" : "active" };
  },
};
const intent = (home: string): IntentDeps => ({
  pipeline: { lexicon: loadLexicon(home), tagRouter: createRoleTagRouter(Object.values(ROLES)) },
  classifier,
});

test("running dev run: supplement -> steered (task.steer {len}, no body, reply says received); independent dev work -> auto-queued, an independent assistant question -> answered at once (side lane); cap -> too many pending; unread steers -> notice; after the run -> not steered", async () => {
  const env = await setup();
  const pulled: string[] = [];
  let devRuns = 0;
  let started!: () => void;
  const devStarted = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const query = (a: any) =>
    (async function* () {
      const o = a.options;
      if (!o.tools.includes("Write")) {
        yield resultMsg({ result: "assistant answer" });
        return;
      }
      // dev run: streaming input; pull the task prompt, announce, wait, then read the steer the owner sent
      const it = a.prompt[Symbol.asyncIterator]();
      const prompt = (await it.next()).value.message.content as string;
      yield initMsg;
      // a queued task that starts after the first one ended has no steer to wait for
      if (++devRuns > 1) {
        yield resultMsg({ result: "queued task done" });
        return;
      }
      pulled.push(prompt);
      started();
      await gate;
      const steer = (await it.next()).value.message.content as string;
      pulled.push(steer);
      yield { type: "user", isReplay: true, message: { role: "user", content: steer } }; // the CLI echo: read
      writeFileSync(join(o.cwd, "b.txt"), "x\n");
      await g(o.cwd, "add", "b.txt");
      await g(
        o.cwd,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        "b",
      );
      yield resultMsg({ result: "Xong", session_id: "sess-exec" });
    })();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({
      confirm: async () => ({ approved: false, reason: "owner declined" }),
      askChoice: async (a) => a.options[0],
    }),
    queryFn: query as never,
    intent: intent(env.home),
  });
  const logs = captureLogs();
  const first = handle(msg("please add b.txt with two"));
  await devStarted;
  // a supplement while the dev run works: steered; the reply says "received", never "read"
  const secret = "steer-body-must-not-be-logged";
  const noted = await handle(msg(`also keep it small ${secret}`));
  expect(noted).toBe(STEER_RECEIVED);
  expect(noted).not.toMatch(/read/i);
  // independent staged work: queued at once, no yes/no question; an independent QUESTION for the assistant is
  // answered at once by the side lane (a parallel read-only run) while the task still runs
  expect(await handle(msg("other: add c.txt"))).toBe(QUEUE_RECEIVED);
  expect(await handle(msg("ask: what is going on"))).toBe("assistant answer");
  expect(listPendingProposals(env.db)).toHaveLength(0);
  expect(queuedRoles(env.db)).toEqual(["dev"]);
  // cap: 5 pending (the fake has not pulled the steer yet), the next one is refused
  for (let n = 0; n < 4; n++) expect(await handle(msg(`more ${n}`))).toBe(STEER_RECEIVED);
  expect(await handle(msg("one more"))).toBe(STEER_FULL);
  release();
  const firstReply = await first;
  // the fake pulled the task prompt and the first steer only; the others stay unread and are dropped on close
  // (never silent: the owner gets a notice listing them)
  expect(firstReply).toContain(NOT_DELIVERED);
  expect(firstReply).toContain("more 3");
  expect(firstReply).not.toContain("also keep it small");
  expect(
    env.db.query("SELECT role, status FROM proposals ORDER BY created_at, rowid").all(),
  ).toEqual([
    { role: "dev", status: "dispatched" }, // the running task's own proposal
    { role: "dev", status: "dispatched" }, // queued: started by the drain
  ]);
  expect(pulled[0]).toContain("add b.txt");
  expect(pulled[1]).toContain("also keep it small");
  // log: length only
  const lines = logs.lines.filter((l: any) => l.event === "task.steer");
  expect(lines.length).toBe(5);
  expect(lines[0]).toMatchObject({ len: expect.any(Number) });
  expect(JSON.stringify(logs.lines)).not.toContain(secret);
  logs.stop();
  // audit: every message was stored in arrival order with its kind; the echoed one is delivered, the unread are dropped
  const rows = listRunMessages(env.db, "th1");
  expect(rows.map((r) => r.kind)).toEqual([
    "steer",
    "followup",
    "other", // the side question
    "steer",
    "steer",
    "steer",
    "steer",
    "steer",
  ]);
  expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(rows[0]).toMatchObject({ status: "delivered", runId: expect.any(String) });
  expect(rows.slice(3, 7).map((r) => r.status)).toEqual(Array(4).fill("dropped"));
  expect(rows[7]).toMatchObject({ status: "skipped" }); // refused by the cap: never given to the run
  // the run ended: a message is not a steer any more (the assistant answers it)
  expect(await handle(msg("ask: and now?"))).toBe("assistant answer");
});

/** L3 for the tag tests: `other` = independent (new), `hmm` = unsure (low), `boom` = fails, else a supplement. It also records what it saw. */
function scopedClassifier(seen: string[]): IntentClassifier {
  return {
    classify: async (i): Promise<IntentResult> => {
      seen.push(i.text);
      if (i.text.includes("boom")) throw new Error("engine down");
      // L3's own role pick must not override a tag: it says assistant for a tagged message
      const base = { reason: "r", role: i.text.startsWith("[") ? "assistant" : "dev" };
      if (i.text.includes("hmm")) return { ...base, scope: "new", confidence: "low" as const };
      return {
        ...base,
        scope: i.text.includes("other") ? "new" : "active",
        confidence: "high" as const,
      };
    },
  };
}

test("[dev] tag while a steerable run works: the tag only picks the role, L3 decides the scope (independent -> queue, supplement -> steer, ambiguous -> steer)", async () => {
  const env = await setup();
  let started!: () => void;
  const devStarted = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let devRuns = 0;
  const query = (a: any) =>
    (async function* () {
      const it = a.prompt[Symbol.asyncIterator]();
      await it.next();
      yield initMsg;
      if (++devRuns === 1) {
        started();
        await gate;
      }
      yield resultMsg({ result: "done" });
    })();
  const l3: string[] = [];
  const deps = intent(env.home);
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({
      confirm: async () => ({ approved: false, reason: "owner declined" }),
      askChoice: async (a) => a.options[0],
    }),
    queryFn: query as never,
    intent: { ...deps, classifier: scopedClassifier(l3) },
  });
  const first = handle(msg("please add b.txt with two"));
  await devStarted;
  l3.length = 0; // (the first message went through L3 too: it started the task)
  // a tagged message that is a NEW task: L3 is asked (the tag no longer decides the scope), it queues
  expect(await handle(msg("[dev] other task"))).toBe(QUEUE_RECEIVED);
  expect(l3).toEqual(["[dev] other task"]);
  // role from the tag, not from L3 (which said assistant)
  expect(queuedRoles(env.db)).toEqual(["dev"]);
  // a tagged supplement steers
  expect(await handle(msg("[dev] also keep it small"))).toBe(STEER_RECEIVED);
  // ambiguous (L3 unsure, or L3 failing) = supplement, never a lost message; also untagged
  expect(await handle(msg("[dev] hmm"))).toBe(STEER_RECEIVED);
  expect(await handle(msg("[dev] boom"))).toBe(STEER_RECEIVED);
  expect(await handle(msg("hmm what about it"))).toBe(STEER_RECEIVED);
  expect(l3).toHaveLength(5); // one L3 call per message while the run works (the failing one included)
  expect(rowKinds(env.db)).toEqual(["followup", "steer", "steer", "steer", "steer"]);
  release();
  await first;
});

/** Kinds of the thread's stored messages, in arrival order. */
const rowKinds = (db: ReturnType<typeof makeEnv>["db"]) =>
  listRunMessages(db, "th1").map((r) => r.kind);
