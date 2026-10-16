import { expect, test } from "bun:test";
import { listUndelivered } from "../src/storage/thread-event-store";
import { leadHarness, until, workersDone } from "./lead-harness";

/* End to end with a fake query: owner -> lead -> DispatchAgent -> worker -> ReportResult -> announce -> ForwardResult. */

const ITEM = /task=([0-9a-f-]{36})/;

test("DIRECT -> worker -> ReportResult -> announce -> ForwardResult, then a follow-up answered from the result file", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.tool("ReportResult", { status: "COMPLETED", summary: "deleted 2 dirs" });
      return "Deleted node_modules and dist in location.";
    }
    if (c.prompt.includes("Owner message:\nclean node_modules")) {
      const r = await c.tool("DispatchAgent", {
        strategy: "DIRECT",
        intent: "clean node_modules",
        reason: "one specialist covers it",
        assignments: [
          {
            key: "main",
            role: "developer",
            brief: "Remove node_modules in location",
            location: "location",
            dependsOn: [],
          },
        ],
      });
      expect(r.ok).toBe(true);
      return "On it.";
    }
    if (c.prompt.includes("Task events")) {
      const id = ITEM.exec(c.prompt)?.[1] as string;
      const f = await c.tool("ForwardResult", { taskId: id, mode: "verbatim" });
      expect(f.ok).toBe(true);
      return "";
    }
    // Follow-up: the data block holds the result excerpt; no new worker is needed.
    const excerpt = /Deleted node_modules[^|]*/.exec(c.prompt)?.[0] ?? "no data";
    return `I deleted: ${excerpt}`;
  });
  expect(await h.send("clean node_modules in location")).toBeUndefined(); // the lead posts, not the handler
  await until(() => h.posts.some((p) => p.includes("Deleted node_modules")));
  expect(h.posts[0]).toBe("On it.");
  expect(h.ofKind("worker")).toHaveLength(1);
  // The worker never posted: its text reached the owner only through ForwardResult (the file, posted verbatim).
  expect(h.posts.filter((p) => p.includes("Deleted node_modules"))).toHaveLength(1);
  const goal = h.env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NULL").all();
  expect(goal).toEqual([{ status: "completed" }]);
  await h.send("what did you delete?");
  await until(() => h.posts.some((p) => p.startsWith("I deleted: Deleted node_modules")));
  expect(h.ofKind("worker")).toHaveLength(1); // answered from the result, no re-scan
  expect(listUndelivered(h.env.db, "t1").filter((e) => e.kind !== "start")).toEqual([]);
});

/** One DispatchAgent call with the given assignments. */
const dispatch = (
  c: { tool: (n: string, a: object) => Promise<any> },
  assignments: object[],
  over: object = {},
) =>
  c.tool("DispatchAgent", {
    strategy: assignments.length === 1 ? "DIRECT" : "DELEGATE",
    intent: "work",
    reason: "test",
    assignments,
    ...over,
  });
const a = (key: string, dependsOn: string[] = []) => ({
  key,
  role: "scout",
  brief: `do ${key}`,
  dependsOn,
});

test("DELEGATE with 4 assignments -> NEEDS_PLAN; a cycle -> CYCLE; nothing is started", async () => {
  const codes: string[] = [];
  const h = leadHarness(async (c) => {
    codes.push((await dispatch(c, [a("a"), a("b"), a("c"), a("d")])).code);
    codes.push((await dispatch(c, [a("x", ["y"]), a("y", ["x"])])).code);
    return "refused";
  });
  await h.send("do many things");
  await until(() => h.posts.includes("refused"));
  expect(codes).toEqual(["NEEDS_PLAN", "CYCLE"]);
  expect(h.ofKind("worker")).toHaveLength(0);
  expect(h.env.db.query("SELECT COUNT(*) AS n FROM owned_tasks").get()).toEqual({ n: 0 });
});

test("the 4th chained dispatch without an owner message is refused CHAIN_CAP", async () => {
  const codes: (string | true)[] = [];
  let n = 0;
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.tool("ReportResult", { status: "COMPLETED", summary: "ok" });
      return "done";
    }
    const r = await dispatch(c, [a(`k${++n}`)]);
    codes.push(r.ok ? true : r.code);
    return "";
  });
  await h.send("go on");
  await until(() => codes.length === 4, 8000);
  expect(codes).toEqual([true, true, true, "CHAIN_CAP"]);
  expect(h.ofKind("worker")).toHaveLength(3);
});

test("lead over $3/day -> fixed notice, no lead run, no dispatch", async () => {
  const h = leadHarness(async (c) => ({ text: "first", cost: 3.5 }));
  await h.send("one");
  await until(() => h.posts.includes("first"));
  await h.send("two");
  await until(() => h.posts.some((p) => p.includes("daily budget")));
  expect(h.ofKind("lead")).toHaveLength(1);
  expect(h.ofKind("worker")).toHaveLength(0);
});

test("a lead run that errors posts the fixed notice and starts nothing", async () => {
  const h = leadHarness(async () => {
    throw new Error("boom");
  });
  await h.send("hello");
  await until(() => h.posts.some((p) => p.includes("could not answer")));
  expect(h.ofKind("worker")).toHaveLength(0);
});

test("a worker question becomes an event; SteerTask answers it and the worker continues", async () => {
  const answers: unknown[] = [];
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      const ask = c.options.canUseTool;
      const r = await ask(
        "AskUserQuestion",
        { questions: [{ question: "Which dir?", options: [{ label: "a" }, { label: "b" }] }] },
        {},
      );
      answers.push(r.updatedInput?.answers);
      await c.tool("ReportResult", { status: "COMPLETED", summary: "used b" });
      return "done with b";
    }
    if (c.prompt.includes("Owner message:\nstart")) {
      await dispatch(c, [{ key: "main", role: "developer", brief: "do it", dependsOn: [] }]);
      return "started";
    }
    const id = ITEM.exec(c.prompt)?.[1] as string;
    if (c.prompt.includes("question task=")) {
      const s = await c.tool("SteerTask", { taskId: id, text: "b" });
      expect(s.result).toBe("answered");
      return "answered the worker";
    }
    return "";
  });
  await h.send("start");
  await until(() => h.posts.includes("answered the worker"), 8000);
  await until(() => answers.length === 1);
  expect(answers[0]).toEqual({ "Which dir?": "b" });
});
