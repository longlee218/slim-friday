import { expect, test } from "bun:test";
import { createLeadIo } from "../src/orchestrator/lead/lead-io";
import { createLeadQueue } from "../src/orchestrator/lead/lead-queue";
import type { LeadRuntime, LeadThreadCtx } from "../src/orchestrator/lead/lead-runtime";
import { stopThread } from "../src/orchestrator/turns/turn-stop";
import { makeEnv, stubGateway } from "./helpers";

/* The IO of a lead run: owner buttons (10 min wait), relay of the answer to a waiting worker, posts, `/stop` and the queue. */

function setup(over: Parameters<typeof stubGateway>[0] = {}) {
  const env = makeEnv();
  const posts: string[] = [];
  const answered: [string, string][] = [];
  const ctx = {
    message: { notify: async (t: string) => void posts.push(t) },
  } as unknown as LeadThreadCtx;
  const rt = {
    deps: { approvals: stubGateway(over) },
    relay: { answer: (id: string, t: string) => (answered.push([id, t]), true) },
  } as unknown as LeadRuntime;
  return { env, posts, answered, ctx, rt };
}

test("AskOwner: the owner's click is returned and handed to the worker that waits; a timeout cancels the buttons", async () => {
  const s = setup({ askChoice: async () => "b" });
  const io = createLeadIo(s.rt, s.ctx, "t", "turn", new AbortController().signal);
  expect(
    await io.askOwner({ question: "q", options: ["a", "b"], taskId: "item1", workerAskId: "w" }),
  ).toEqual({ answer: "b", timedOut: false });
  expect(s.answered).toEqual([["item1", "b"]]);
  let cancelled = false;
  const slow = setup({
    askChoice: () => new Promise(() => {}),
    cancelTurn: () => {
      cancelled = true;
    },
  });
  const io2 = createLeadIo(slow.rt, slow.ctx, "t", "turn", new AbortController().signal, 20);
  expect(await io2.askOwner({ question: "q", options: ["a", "b"] })).toEqual({
    answer: undefined,
    timedOut: true,
  });
  expect(cancelled).toBe(true);
});

test("post: text is posted; a send failure is swallowed (logged), an aborted run posts nothing", async () => {
  const s = setup();
  const ac = new AbortController();
  const io = createLeadIo(s.rt, s.ctx, "t", "turn", ac.signal);
  await io.post({ text: "hello" });
  expect(s.posts).toEqual(["hello"]);
  ac.abort();
  await io.post({ text: "late" });
  expect(s.posts).toEqual(["hello"]);
  const bad = {
    message: {
      notify: async () => {
        throw new Error("send failed");
      },
    },
  } as unknown as LeadThreadCtx;
  await createLeadIo(s.rt, bad, "t", "turn", new AbortController().signal).post({ text: "x" }); // must not throw
});

test("/stop with only a queued lead input: the queue is dropped and the owner is told work was stopped", async () => {
  const { db } = makeEnv();
  const ran: string[] = [];
  const queue = createLeadQueue({ run: async (i) => void ran.push(i.threadId), debounceMs: 50 });
  queue.push({ threadId: "t", kind: "owner", messageIds: ["m"], text: "hi" }); // debouncing
  expect(queue.busy("t")).toBe(true);
  const reply = stopThread(db, "t", "en", queue);
  expect(reply.length).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 120));
  expect(ran).toEqual([]);
  expect(queue.busy("t")).toBe(false);
});

test("/stop tree: unstarted items of the open goal are cancelled and the goal settles, so no later pass starts them", async () => {
  const { db } = makeEnv();
  const { insertOwnedTask } = await import("../src/storage/owned-task-store");
  const { stopThreadTree } = await import("../src/orchestrator/run/stop-thread-tree");
  insertOwnedTask(db, {
    id: "g",
    threadId: "t",
    ownerRole: "lead",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  const item = (id: string, key: string, status: string) =>
    insertOwnedTask(db, {
      id,
      threadId: "t",
      ownerRole: "scout",
      status: status as never,
      scope: key,
      correlationId: "c",
      parentId: "g",
      itemKey: key,
      dependsOn: [],
    });
  item("a", "a", "ready");
  item("b", "b", "pending");
  stopThreadTree(db, "t");
  const status = (id: string) =>
    (db.query("SELECT status FROM owned_tasks WHERE id = ?").get(id) as any).status;
  expect([status("a"), status("b"), status("g")]).toEqual(["cancelled", "cancelled", "cancelled"]);
});
