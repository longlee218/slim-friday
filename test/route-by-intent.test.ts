import { expect, test } from "bun:test";
import type { IntentDecision } from "../src/intent/decide-intent";
import { DECLINE_BUSY_REPLY, drainQueued } from "../src/orchestrator/dispatch/queued-tasks";
import { STILL_WORKING, stripRoleTag } from "../src/orchestrator/thread/intent-replies";
import {
  actionFor,
  FIX_LIMIT_REPLY,
  type IntentAction,
  MAX_FIX_ROUNDS,
  type RouteCtx,
  routeByIntent,
} from "../src/orchestrator/thread/route-by-intent";
import type { ThreadState } from "../src/orchestrator/thread/thread-state";
import {
  getProposal,
  insertProposal,
  oldestQueuedProposal,
  pendingProposal,
  refuseQueued,
} from "../src/storage/proposal-store";
import { makeEnv, stubGateway, TEST_CHANNEL } from "./helpers";

const role = (r: string, scope: "active" | "new"): IntentDecision => ({
  kind: "role",
  role: r,
  scope,
});
const act = (decision: IntentDecision, state: ThreadState, hasClone = false, fixRounds = 0) =>
  actionFor({ decision, state, hasClone, fixRounds });

/* Every row of the behavior table (phase 09), state x role x scope. */

test("idle / done: assistant runs; dev new opens a task; dev active with a clone fixes", () => {
  for (const s of ["idle", "done"] as const) {
    expect(act(role("assistant", "new"), s)).toEqual({ kind: "run", role: "assistant" });
    expect(act(role("assistant", "active"), s, true)).toEqual({ kind: "run", role: "assistant" });
    expect(act(role("dev", "new"), s)).toEqual({ kind: "open", role: "dev" });
    expect(act(role("dev", "new"), s, true)).toEqual({ kind: "open", role: "dev" });
    expect(act(role("dev", "active"), s, true)).toEqual({ kind: "fix", role: "dev" });
    // "active" without a clone cannot continue anything: a new task
    expect(act(role("dev", "active"), s, false)).toEqual({ kind: "open", role: "dev" });
  }
});

test("awaiting_plan_approval: dev active = plan feedback; assistant answers, gate stays; dev new queues", () => {
  expect(act(role("dev", "active"), "awaiting_plan_approval")).toEqual({
    kind: "feedback",
    role: "dev",
  });
  expect(act(role("assistant", "active"), "awaiting_plan_approval")).toEqual({
    kind: "side",
    role: "assistant",
  });
  expect(act(role("assistant", "new"), "awaiting_plan_approval")).toEqual({
    kind: "side",
    role: "assistant",
  });
  expect(act(role("dev", "new"), "awaiting_plan_approval")).toEqual({ kind: "queue", role: "dev" });
});

test("running: dev active steers (P1.4b); assistant = side question; dev new queues", () => {
  expect(act(role("dev", "active"), "running")).toEqual({ kind: "steer", role: "dev" });
  expect(act(role("assistant", "new"), "running")).toEqual({ kind: "side", role: "assistant" });
  expect(act(role("dev", "new"), "running")).toEqual({ kind: "queue", role: "dev" });
});

test("awaiting_result: dev active = bounded fix loop; assistant answers, gate stays; dev new queues", () => {
  expect(act(role("dev", "active"), "awaiting_result", true, 0)).toEqual({
    kind: "fix",
    role: "dev",
  });
  expect(act(role("dev", "active"), "awaiting_result", true, MAX_FIX_ROUNDS - 1)).toEqual({
    kind: "fix",
    role: "dev",
  });
  expect(act(role("dev", "active"), "awaiting_result", true, MAX_FIX_ROUNDS)).toEqual({
    kind: "fix-limit",
  });
  expect(act(role("assistant", "active"), "awaiting_result", true)).toEqual({
    kind: "side",
    role: "assistant",
  });
  expect(act(role("dev", "new"), "awaiting_result", true)).toEqual({ kind: "queue", role: "dev" });
});

test("the fix loop is capped after a clone is idle too (max 2 rounds per task)", () => {
  expect(act(role("dev", "active"), "idle", true, 1)).toEqual({ kind: "fix", role: "dev" });
  expect(act(role("dev", "active"), "idle", true, 2)).toEqual({ kind: "fix-limit" });
});

test("awaiting_confirmation (no stage uses it yet): active staged waits, new queues", () => {
  expect(act(role("dev", "active"), "awaiting_confirmation")).toEqual({
    kind: "steer",
    role: "dev",
  });
  expect(act(role("dev", "new"), "awaiting_confirmation")).toEqual({ kind: "queue", role: "dev" });
});

test("any state: ask decisions (low confidence, unknown role, failure) and unknown roles ask the owner", () => {
  const states: ThreadState[] = [
    "idle",
    "done",
    "running",
    "awaiting_plan_approval",
    "awaiting_result",
  ];
  for (const s of states) {
    for (const reason of [
      "low_confidence",
      "unknown_role",
      "unclassified",
      "pending_unclear",
    ] as const)
      expect(act({ kind: "ask", reason }, s)).toEqual({ kind: "ask", reason });
    expect(act(role("ghost", "new"), s)).toEqual({ kind: "ask", reason: "unknown_role" });
  }
});

test("pending answers (read by L3): to a queued/pending ask -> answer-ask; to a button gate -> hint", () => {
  for (const s of ["idle", "running", "awaiting_plan_approval"] as ThreadState[]) {
    expect(act({ kind: "gate-answer", answer: "yes", target: "ask" }, s)).toEqual({
      kind: "answer-ask",
      answer: "yes",
    });
    expect(act({ kind: "gate-answer", answer: "no", target: "ask" }, s)).toEqual({
      kind: "answer-ask",
      answer: "no",
    });
    expect(act({ kind: "gate-answer", answer: "yes", target: "gate" }, s)).toEqual({
      kind: "gate-hint",
    });
  }
});

/* Executor: what each action does (no SDK anywhere). */

function ctx(over: Partial<RouteCtx> = {}) {
  const env = makeEnv();
  const c = {
    deps: { db: env.db, config: env.config, approvals: stubGateway() } as never,
    task: { source: "t", channelId: TEST_CHANNEL, userId: "u", threadId: "th", text: "x" },
    workspace: "main",
    repos: [],
    ac: new AbortController(),
    busy: true,
    text: "please add retries to fetch",
    ...over,
  } satisfies RouteCtx;
  return { env, c };
}
const text = (o: { kind: string; text?: string }) =>
  o.kind === "reply" ? (o.text as string) : "RUN";

test("executor: without the approval flow a staged task is refused by text (queue and open)", async () => {
  const { env, c } = ctx();
  const bare = { ...c, deps: { db: env.db, config: env.config } as never };
  for (const kind of ["queue", "open"] as const) {
    const r = await routeByIntent({ ...bare, busy: kind === "queue" }, { kind, role: "dev" });
    expect(text(r)).toBe("This task needs the Discord approval flow.");
  }
});

test("executor: asks, hints, fix limit and the P1.4b rows are replies; none runs anything", async () => {
  const { c } = ctx();
  const idle = { ...c, busy: false };
  const generic = text(await routeByIntent(idle, { kind: "ask", reason: "low_confidence" }));
  expect(generic).toContain("not sure what you want");
  expect(generic).not.toMatch(/\[ask\]|\[dev\]|Start your message/); // no tag instructions
  // the model's own question wins over the generic text
  expect(
    text(
      await routeByIntent(idle, { kind: "ask", reason: "low_confidence", text: "Ý bạn là gì?" }),
    ),
  ).toBe("Ý bạn là gì?");
  // busy: never the ask, the run is still going
  expect(
    text(await routeByIntent({ ...c, busy: true }, { kind: "ask", reason: "low_confidence" })),
  ).toBe(STILL_WORKING);
  expect(text(await routeByIntent(c, { kind: "gate-hint" }))).toContain("Approve / Reject");
  expect(text(await routeByIntent(c, { kind: "fix-limit" }))).toBe(FIX_LIMIT_REPLY);
  expect(text(await routeByIntent(c, { kind: "steer", role: "dev" }))).toBe(STILL_WORKING);
  expect(text(await routeByIntent(c, { kind: "side", role: "assistant" }))).toBe(STILL_WORKING);
});

test("executor: rows that need the thread free give 'still working...' while a run holds the lock, else run", async () => {
  const busy = ctx().c;
  for (const a of [
    { kind: "run", role: "assistant" },
    { kind: "fix", role: "dev" },
    { kind: "open", role: "dev" },
  ] as IntentAction[])
    expect(text(await routeByIntent(busy, a))).toBe(STILL_WORKING);
  const free = ctx({ busy: false, cls: "design", effort: "high" }).c;
  expect(await routeByIntent(free, { kind: "run", role: "assistant" })).toEqual({
    kind: "run",
    role: "assistant",
    cls: "design",
    effort: "high",
  });
  expect(await routeByIntent(free, { kind: "fix", role: "dev" })).toMatchObject({
    kind: "run",
    role: "dev",
  });
});

test("queue: a second dev task is persisted pending and asked ONCE; a newer ask supersedes the older", async () => {
  const { env, c } = ctx({ repo: "api", cls: "mechanical" });
  const q = text(await routeByIntent(c, { kind: "queue", role: "dev" }));
  expect(q).toContain("Run this after it? Reply yes or no");
  const p1 = pendingProposal(env.db, "th")!;
  expect(p1).toMatchObject({ role: "dev", repo: "api", class: "mechanical", status: "pending" });
  expect(p1.brief).toContain("please add retries");
  await routeByIntent({ ...c, text: "second ask" }, { kind: "queue", role: "dev" });
  expect(getProposal(env.db, p1.id)!.status).toBe("expired");
  expect(pendingProposal(env.db, "th")!.brief).toContain("second ask");
});

test("yes while running -> queued (starts at the end of the active task); no -> refused; nothing pending -> told", async () => {
  const { env, c } = ctx();
  expect(text(await routeByIntent(c, { kind: "answer-ask", answer: "yes" }))).toBe(
    "Nothing is waiting for an answer.",
  );
  await routeByIntent(c, { kind: "queue", role: "dev" });
  expect(text(await routeByIntent(c, { kind: "answer-ask", answer: "yes" }))).toContain("Queued");
  expect(oldestQueuedProposal(env.db, "th")).toMatchObject({ status: "queued", role: "dev" });
  expect(pendingProposal(env.db, "th")).toBeNull();
  await routeByIntent(c, { kind: "queue", role: "dev" });
  expect(text(await routeByIntent(c, { kind: "answer-ask", answer: "no" }))).toBe("Dropped.");
  expect(pendingProposal(env.db, "th")).toBeNull();
});

test("a pending proposal older than the TTL is expired, not queued", async () => {
  const { env, c } = ctx();
  const id = insertProposal(
    env.db,
    { threadId: "th", workspace: "main", role: "dev", brief: "old task" },
    Date.now() - 25 * 3_600_000,
  );
  expect(text(await routeByIntent(c, { kind: "answer-ask", answer: "yes" }))).toContain("expired");
  expect(getProposal(env.db, id)!.status).toBe("expired");
});

test("stop refuses queued proposals; an aborted run does not drain them", async () => {
  const { env, c } = ctx();
  await routeByIntent(c, { kind: "queue", role: "dev" });
  await routeByIntent(c, { kind: "answer-ask", answer: "yes" });
  expect(refuseQueued(env.db, "th")).toBe(1);
  expect(oldestQueuedProposal(env.db, "th")).toBeNull();
  // drain with an aborted run: nothing starts, the reply is unchanged
  await routeByIntent(c, { kind: "queue", role: "dev" });
  await routeByIntent(c, { kind: "answer-ask", answer: "yes" });
  c.ac.abort();
  expect(await drainQueued({ ...c, deps: c.deps }, "done.")).toBe("done.");
  expect(oldestQueuedProposal(env.db, "th")).not.toBeNull();
});

test("stripRoleTag drops the leading role tag only", () => {
  expect(stripRoleTag("[dev] add x")).toBe("add x");
  expect(stripRoleTag("  [ASK]  why?")).toBe("why?");
  expect(stripRoleTag("add [dev] x")).toBe("add [dev] x");
  expect(stripRoleTag("[dev]")).toBe("[dev]"); // nothing left: keep the text
});

test("'no' to 'Open a dev task for this?': free thread -> assistant answers the message; busy -> waits, question stays", async () => {
  const { env, c } = ctx();
  const id = insertProposal(env.db, {
    threadId: "th",
    workspace: "main",
    role: "dev",
    brief: "Tôi đề xuất xây dựng cache",
    reason: "confirm_dev",
  });
  const no = { kind: "answer-ask", answer: "no" } as const;
  const busy = await routeByIntent({ ...c, busy: true }, no);
  expect(text(busy)).toBe(DECLINE_BUSY_REPLY);
  expect(getProposal(env.db, id)?.status).toBe("pending"); // still answerable later
  const free = await routeByIntent({ ...c, busy: false }, no);
  expect(free).toMatchObject({
    kind: "run",
    role: "assistant",
    text: "Tôi đề xuất xây dựng cache",
  });
  expect(getProposal(env.db, id)?.status).toBe("refused");
});
