import { expect, test } from "bun:test";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { appendEffect } from "../src/storage/effect-log-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { decisionOf, loadGolden, STRATEGIES } from "./lead-golden-support";

/* Shape of the lead golden set (no API call; the paid run is lead-golden.eval.test.ts). */

const cases = loadGolden();
const workers = dispatchableWorkers().map((r) => r.name);

test("golden set: about 20 cases, unique ids and texts, every strategy covered", () => {
  expect(cases.length).toBeGreaterThanOrEqual(20);
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  expect(new Set(cases.map((c) => c.text)).size).toBe(cases.length);
  for (const s of STRATEGIES) expect(cases.some((c) => c.strategy === s)).toBe(true);
});

test("golden set: strategy and roles agree and every role is a dispatchable registry worker", () => {
  for (const c of cases.flatMap((c) => [c, ...(c.alt ?? [])])) {
    expect(STRATEGIES).toContain(c.strategy);
    for (const r of c.roles) expect(workers).toContain(r);
    if (c.strategy === "DIRECT") expect(c.roles).toHaveLength(1);
    if (c.strategy === "DELEGATE") expect(c.roles.length).toBeGreaterThan(1);
    if (c.strategy === "ANSWER" || c.strategy === "PLAN") expect(c.roles).toEqual([]);
  }
});

test("decisionOf reads the recorded dispatch: none, one item, two items, a plan request", () => {
  const db = openDb(":memory:");
  expect(decisionOf(db)).toEqual({ strategy: "ANSWER", roles: [] });
  const item = (id: string, role: string) => {
    insertOwnedTask(db, {
      id,
      threadId: "th",
      ownerRole: role,
      status: "open",
      scope: "s",
      correlationId: "c",
      parentId: "g",
      itemKey: id,
    });
  };
  item("i1", "developer");
  expect(decisionOf(db)).toEqual({ strategy: "DIRECT", roles: ["developer"] });
  item("i2", "scout");
  expect(decisionOf(db)).toEqual({ strategy: "DELEGATE", roles: ["developer", "scout"] });
  appendEffect(db, {
    id: "k",
    threadId: "th",
    tool: "Orchestrate.request_plan",
    scope: "lead tool call",
    grantedBy: "role",
    result: "{}",
  });
  expect(decisionOf(db)).toEqual({ strategy: "PLAN", roles: [] });
  db.close();
});
