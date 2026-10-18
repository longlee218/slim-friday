import { expect, test } from "bun:test";
import { openDb } from "../src/storage/db";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { KINDS, loadScoutCases, outcomeOf, urlsOf } from "./scout-eval-support";

/* Shape of the scout research set (no API call; the paid run is scout-research.eval.test.ts). */

const cases = loadScoutCases();

test("research set: 20-50 cases, unique ids and texts, known kinds, every kind covered", () => {
  expect(cases.length).toBeGreaterThanOrEqual(20);
  expect(cases.length).toBeLessThanOrEqual(50);
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
  for (const c of cases) expect(KINDS).toContain(c.kind);
  for (const k of KINDS) expect(cases.some((c) => c.kind === k)).toBe(true);
});

test("urlsOf: distinct URLs, trailing punctuation and markdown closers trimmed", () => {
  expect(
    urlsOf(
      "see https://a.dev/x. and [d](https://b.dev/y), also https://a.dev/x and (https://c.dev)",
    ),
  ).toEqual(["https://a.dev/x", "https://b.dev/y", "https://c.dev"]);
  expect(urlsOf("no links")).toEqual([]);
});

test("outcomeOf: empty db = not completed; a completed scout item gives its excerpt", () => {
  const db = openDb(":memory:");
  expect(outcomeOf(db, () => "").completed).toBe(false);
  insertOwnedTask(db, {
    id: "i1",
    threadId: "th",
    ownerRole: "scout",
    status: "completed",
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "i1",
  });
  db.query("UPDATE owned_tasks SET result_excerpt = 'x https://a.dev' WHERE id = 'i1'").run();
  const o = outcomeOf(db, () => "");
  expect(o.completed).toBe(true);
  expect(urlsOf(o.text)).toEqual(["https://a.dev"]);
  db.close();
});
