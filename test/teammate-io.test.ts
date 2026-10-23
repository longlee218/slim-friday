import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import type { ViewerConfig } from "../src/config/viewer-config";
import { createTeammateIo } from "../src/orchestrator/teammate/teammate-io";
import { createTeammateQueue } from "../src/orchestrator/teammate/teammate-queue";
import type {
  TeammateRuntime,
  TeammateThreadCtx,
} from "../src/orchestrator/teammate/teammate-runtime";
import { stopThread } from "../src/orchestrator/turns/turn-stop";
import { makeEnv, stubGateway } from "./helpers";

/* The IO of a teammate run: owner buttons (10 min wait), relay of the answer to a waiting worker, posts, `/stop` and the queue. */

function setup(over: Parameters<typeof stubGateway>[0] = {}, viewer?: ViewerConfig) {
  const env = makeEnv();
  const posts: string[] = [];
  const answered: [string, string][] = [];
  const ctx = {
    message: { notify: async (t: string) => void posts.push(t) },
  } as unknown as TeammateThreadCtx;
  const rt = {
    deps: { approvals: stubGateway(over), db: env.db, config: { viewer } },
    relay: { answer: (id: string, t: string) => (answered.push([id, t]), true) },
  } as unknown as TeammateRuntime;
  return { env, posts, answered, ctx, rt };
}

test("Orchestrate ask_owner: the owner's click is returned and handed to the worker that waits; a timeout cancels the buttons", async () => {
  const s = setup({ askChoice: async () => "b" });
  const io = createTeammateIo(s.rt, s.ctx, "t", "turn", new AbortController().signal);
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
  const io2 = createTeammateIo(slow.rt, slow.ctx, "t", "turn", new AbortController().signal, 20);
  expect(await io2.askOwner({ question: "q", options: ["a", "b"] })).toEqual({
    answer: undefined,
    timedOut: true,
  });
  expect(cancelled).toBe(true);
});

test("post: text is posted; a send failure is swallowed (logged), an aborted run posts nothing", async () => {
  const s = setup();
  const ac = new AbortController();
  const io = createTeammateIo(s.rt, s.ctx, "t", "turn", ac.signal);
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
  } as unknown as TeammateThreadCtx;
  await createTeammateIo(s.rt, bad, "t", "turn", new AbortController().signal).post({ text: "x" }); // must not throw
});

test("/stop with only a queued teammate input: the queue is dropped and the owner is told work was stopped", async () => {
  const { db } = makeEnv();
  const ran: string[] = [];
  const queue = createTeammateQueue({
    run: async (i) => void ran.push(i.threadId),
    debounceMs: 50,
  });
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
    ownerRole: "chief-of-staff",
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

test("post: a result file is posted with asFile, plain text is not", async () => {
  const calls: [string, boolean | undefined][] = [];
  const ctx = {
    message: {
      notify: async (t: string, o?: { asFile?: boolean }) => void calls.push([t, o?.asFile]),
    },
  } as unknown as TeammateThreadCtx;
  const s = setup();
  const io = createTeammateIo(s.rt, ctx, "t", "turn", new AbortController().signal);
  const file = join(s.env.home, "result.md");
  writeFileSync(file, "full result");
  await io.post({ filePath: file });
  await io.post({ text: "excerpt" });
  expect(calls).toEqual([
    ["full result", true],
    ["excerpt", false],
  ]);
});

test("post: a result file that is an artifact carries the viewer's Open link when the viewer is on", async () => {
  const cfg: ViewerConfig = {
    port: 1,
    baseUrl: "https://v.example.com",
    secret: "k".repeat(32),
    linkTtlMs: 1000,
  };
  const sent: { links?: { label: string; url: string }[] }[] = [];
  const ctx = {
    message: {
      notify: async (_t: string, o?: { links?: { label: string; url: string }[] }) =>
        void sent.push(o ?? {}),
    },
  } as unknown as TeammateThreadCtx;
  const on = setup({}, cfg);
  const a = writeArtifact(on.env.db, on.env.home, {
    workspace: "main",
    title: "Plan",
    kind: "md",
    body: "# Plan",
  });
  await createTeammateIo(on.rt, ctx, "t", "turn", new AbortController().signal).post({
    filePath: a.path,
  });
  expect(sent[0]?.links?.[0]?.label).toBe("Open");
  expect(sent[0]?.links?.[0]?.url).toContain(`https://v.example.com/a/${a.id}?e=`);
  // Viewer off: no link.
  const off = setup();
  const b = writeArtifact(off.env.db, off.env.home, {
    workspace: "main",
    title: "Plan",
    kind: "md",
    body: "# Plan",
  });
  await createTeammateIo(off.rt, ctx, "t", "turn", new AbortController().signal).post({
    filePath: b.path,
  });
  expect(sent[1]?.links).toEqual([]);
});

test("post: a non-markdown result file keeps its real file name (html is never posted as reply.md)", async () => {
  const names: (string | undefined)[] = [];
  const ctx = {
    message: {
      notify: async (_t: string, o?: { fileName?: string }) => void names.push(o?.fileName),
    },
  } as unknown as TeammateThreadCtx;
  const s = setup();
  const io = createTeammateIo(s.rt, ctx, "t", "turn", new AbortController().signal);
  const html = join(s.env.home, "lo-trinh-infra.html");
  writeFileSync(html, "<!DOCTYPE html><html><body>x</body></html>");
  const md = join(s.env.home, "other.md");
  writeFileSync(md, "# My Title\n\nbody");
  await io.post({ filePath: html });
  await io.post({ filePath: md });
  expect(names).toEqual(["lo-trinh-infra.html", "my-title.md"]);
});
