import { expect, test } from "bun:test";
import { RESUME_PROMPT } from "../src/orchestrator/worker/resume-prompt";
import { getItem } from "../src/storage/owned-item-store";
import { leadHarness, until } from "./lead-harness";
import { isWorkerRun } from "./mcp-run-probe";

/* The hold policy end to end over the fake query: a failed item is held (dependents wait), the lead retries it with a note,
   a transient API error resumes the same session with backoff, and the cap holds the item for the lead. */

const step = (key: string, dependsOn: string[] = [], role = "developer") => ({
  key,
  subject: `Do ${key}`,
  role,
  brief: `do ${key}`,
  dependsOn,
});
const dispatch = (c: any, assignments: object[]) =>
  c.orchestrate("dispatch", {
    strategy: "DELEGATE",
    small: true,
    intent: "work",
    reason: "test",
    assignments,
  });
/** Session of a run: a resumed run keeps its session, a fresh worker run gets `w<n>`. */
const sessionOf = (options: any, n: number) =>
  options?.resume ?? (isWorkerRun(options) ? `w${n}` : `l${n}`);
/** The item with `key` (undefined until the dispatch created it). */
const itemOf = (h: ReturnType<typeof leadHarness>, key: string) => {
  const r = h.env.db.query("SELECT id FROM owned_tasks WHERE item_key = ?").get(key) as {
    id: string;
  } | null;
  return r ? getItem(h.env.db, r.id) : undefined;
};
const goalStatus = (h: ReturnType<typeof leadHarness>) =>
  (h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").get() as any)?.status;

test("worker FAILED: dependents stay pending, goal stays open; Orchestrate retry resumes the item with the note and the goal completes", async () => {
  let failures = 0;
  const h = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        const key =
          /do (\w+)/.exec(c.prompt)?.[1] ?? (c.prompt.includes(RESUME_PROMPT) ? "a" : "?");
        if (key === "a" && !c.prompt.includes(RESUME_PROMPT)) {
          await c.report("result", { title: "T", status: "FAILED", summary: "broke" });
          return "failed";
        }
        await c.report("result", { title: "T", status: "COMPLETED", summary: `${key} ok` });
        return "ok";
      }
      if (c.prompt.includes("<owner_message>")) {
        await dispatch(c, [step("a"), step("b", ["a"])]);
        return "started";
      }
      const failed = /failure task=([0-9a-f-]{36}) .*"class":"real"/.exec(c.prompt);
      if (failed && failures++ === 0) {
        const r = await c.orchestrate("retry", {
          taskId: failed[1],
          note: "try the other approach",
        });
        expect(r.ok).toBe(true);
      }
      return "";
    },
    undefined,
    {},
    sessionOf,
  );
  await h.send("go");
  await until(() => failures === 1);
  await until(() => goalStatus(h) === "completed", 8000);
  const workers = h.ofKind("worker");
  expect(workers).toHaveLength(3); // a, a retried, b
  const retried = workers[1]!;
  expect(retried.options.resume).toBe(workers[0]!.options.resume ?? "w2");
  expect(retried.prompt).toContain(RESUME_PROMPT);
  expect(retried.prompt).toContain("[steer] lead: try the other approach");
  expect(itemOf(h, "a")).toMatchObject({ status: "completed", dispatchCount: 2, attempt: 0 });
  expect(itemOf(h, "b")?.status).toBe("completed");
});

test("held item: dependents are not started and the goal is not settled while the lead has not decided", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "FAILED", summary: "broke" });
      return "failed";
    }
    if (c.prompt.includes("<owner_message>")) {
      await dispatch(c, [step("a"), step("b", ["a"])]);
      return "started";
    }
    return "";
  });
  await h.send("go");
  await until(() => itemOf(h, "a")?.status === "blocked");
  await new Promise((r) => setTimeout(r, 300));
  expect(itemOf(h, "a")).toMatchObject({ status: "blocked", resultKind: "FAILED" });
  expect(itemOf(h, "b")?.status).toBe("pending");
  expect(goalStatus(h)).toBe("open");
  expect(h.ofKind("worker")).toHaveLength(1);
});

test("overload: the same session is resumed after the backoff, no failure event reaches the lead", async () => {
  let n = 0;
  const h = leadHarness(
    async (c) => {
      if (c.kind === "worker") {
        if (n++ === 0) throw new Error("API Error: 529 overloaded_error");
        await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
        return "ok";
      }
      if (c.prompt.includes("<owner_message>")) {
        await dispatch(c, [step("a")]);
        return "started";
      }
      return "";
    },
    undefined,
    {},
    sessionOf,
  );
  const t0 = Date.now();
  await h.send("go");
  await until(() => goalStatus(h) === "completed", 10_000);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1900); // attempt 1 waits 2 s
  const [first, again] = h.ofKind("worker");
  expect(again!.options.resume).toBe(first!.options.resume ?? "w2");
  expect(again!.prompt).toContain(RESUME_PROMPT);
  expect(itemOf(h, "a")).toMatchObject({ status: "completed", attempt: 1, dispatchCount: 1 });
  expect(
    h.env.db.query("SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'failure'").get(),
  ).toEqual({ n: 0 });
}, 20_000);

test("overload on every run: 2 automatic resumes (+2 s, +4 s), then the item is held with a failure event", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") throw new Error("API Error: 529 overloaded_error");
    if (c.prompt.includes("<owner_message>")) {
      await dispatch(c, [step("a")]);
      return "started";
    }
    return "";
  });
  await h.send("go");
  await until(() => itemOf(h, "a")?.status === "blocked", 15_000);
  expect(h.ofKind("worker")).toHaveLength(3);
  expect(itemOf(h, "a")).toMatchObject({ resultKind: "FAILED", attempt: 2, dispatchCount: 1 });
  const ev = h.env.db.query("SELECT payload FROM thread_events WHERE kind = 'failure'").get() as {
    payload: string;
  };
  expect(JSON.parse(ev.payload)).toMatchObject({
    class: "real",
    cause: "resume_cap:api_error",
    attempt: 2,
  });
  expect(goalStatus(h)).toBe("open");
}, 30_000);

test("start + 2 Orchestrate retry, then a transient failure: the breaker does not kill the resume; after the cap the item is held, never failed", async () => {
  let runs = 0;
  let retries = 0;
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      // Runs 1 and 2 report FAILED (the lead retries them); from run 3 (dispatch 3) the API is overloaded.
      if (++runs <= 2) {
        await c.report("result", { title: "T", status: "FAILED", summary: "broke" });
        return "failed";
      }
      throw new Error("API Error: 529 overloaded_error");
    }
    if (c.prompt.includes("<owner_message>")) {
      await dispatch(c, [step("a"), step("b", ["a"])]);
      return "started";
    }
    const failed = /failure task=([0-9a-f-]{36}) .*"cause":"worker_failed"/.exec(c.prompt);
    if (failed && retries < 2) {
      retries++;
      expect((await c.orchestrate("retry", { taskId: failed[1], note: "again" })).ok).toBe(true);
    }
    return "";
  });
  await h.send("go");
  await until(
    () => runs >= 5 && itemOf(h, "a")?.status === "blocked" && itemOf(h, "a")?.attempt === 2,
    25_000,
  );
  expect(itemOf(h, "a")).toMatchObject({
    status: "blocked",
    resultKind: "FAILED",
    dispatchCount: 3,
    attempt: 2,
  });
  expect(itemOf(h, "b")?.status).toBe("pending");
  expect(goalStatus(h)).toBe("open");
  expect(h.env.db.query("SELECT COUNT(*) AS n FROM turns WHERE role = 'developer'").get()).toEqual({
    n: 5,
  });
}, 40_000);
