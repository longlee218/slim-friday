import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { DEPENDENCY_RESULT_PUSH_CHARS } from "../src/config/message-caps";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import { earlierSteps } from "../src/orchestrator/messages/earlier-steps";
import { messageRef } from "../src/orchestrator/messages/message-ref";
import { postItemMessage } from "../src/orchestrator/messages/task-messages";
import { openDb } from "../src/storage/db";
import { getItem } from "../src/storage/owned-item-store";
import { linkTurn } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";

/* Earlier steps of a run: only its dependencies, each with the start of its result message and a pointer. */

let db: Database;
afterEach(() => db?.close());

/** Goal a -> b, plus an unrelated c; returns the ids. */
async function setup() {
  db = openDb(":memory:");
  const port = createDbEffectPort({
    db,
    threadId: "th",
    env: { workerRoles: ["developer"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
  });
  const asg = (key: string, dependsOn: string[]) => ({
    key,
    subject: `${key} subject`,
    role: "developer",
    brief: `${key} brief`,
    dependsOn,
  });
  const d = (await handleDispatch(
    { port, threadId: "th", leadTurnId: "lt", inputId: "in", run: { dispatched: 0 } },
    {
      strategy: "DELEGATE",
      small: true,
      intent: "i",
      reason: "r",
      assignments: [asg("a", []), asg("b", ["a"]), asg("c", [])],
    },
  )) as unknown as { itemIds: string[] };
  const [a, b, c] = d.itemIds as [string, string, string];
  return {
    a,
    b,
    c,
    item: (id: string) => getItem(db, id) as NonNullable<ReturnType<typeof getItem>>,
  };
}

test("lists only dependencies: status, result ref and text; no artifact ids", async () => {
  const { a, b, c, item } = await setup();
  const m = postItemMessage(db, a, "developer", "result", "dependency result text") as number;
  postItemMessage(db, c, "developer", "result", "other task result");
  const text = earlierSteps(db, item(b));
  expect(text).toContain(`- a [`);
  expect(text).toContain(`result ${messageRef(m)}: dependency result text`);
  expect(text).not.toContain("other task result");
  expect(text).not.toContain("artifact");
  expect(earlierSteps(db, item(c))).toBe("");
});

test("a result over the cap is cut with a read pointer", async () => {
  const { a, b, item } = await setup();
  const m = postItemMessage(
    db,
    a,
    "developer",
    "result",
    "r".repeat(DEPENDENCY_RESULT_PUSH_CHARS + 500),
  ) as number;
  const text = earlierSteps(db, item(b));
  expect(text).not.toContain("r".repeat(DEPENDENCY_RESULT_PUSH_CHARS + 1));
  expect(text).toContain(`Rest: TaskBoard read ${messageRef(m)}`);
});

test("a dependency whose last run left no result message shows its excerpt and says the older result is outdated", async () => {
  const { a, b, item } = await setup();
  const m = postItemMessage(db, a, "developer", "result", "old run result") as number;
  const startedAfter = Date.now() + 10;
  insertTurn(db, { id: "t2", threadId: "th", source: "x", location: "*", role: "developer" });
  linkTurn(db, "t2", a);
  db.query("UPDATE turns SET started_at = ? WHERE id = 't2'").run(startedAfter);
  db.query("UPDATE owned_tasks SET result_excerpt = 'short new excerpt' WHERE id = ?").run(a);
  const text = earlierSteps(db, item(b));
  expect(text).toContain("short new excerpt");
  expect(text).toContain(`${messageRef(m)} is from an earlier run`);
});

test("no dependencies: empty", async () => {
  const { a, item } = await setup();
  expect(earlierSteps(db, item(a))).toBe("");
});
