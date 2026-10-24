import { expect, test } from "bun:test";
import { openEngineStore } from "../src/engine-store";

test("ticketEvents.list is oldest first, same-ms rows in insert order", async () => {
  const s = openEngineStore(":memory:");
  const e = (id: string, at: number, over = {}) => ({
    id,
    ticketId: "t1",
    kind: "status" as const,
    actor: { kind: "user" as const },
    at,
    ...over,
  });
  await s.ticketEvents.append(e("z", 20));
  // Ids sort against insert order on purpose: the same-ms pair must follow insertion.
  await s.ticketEvents.append(
    e("b", 10, { kind: "assignee", from: "b1", to: "b2", actor: { kind: "bot", botId: "b1" } }),
  );
  await s.ticketEvents.append(e("a", 10, { kind: "created" }));
  await s.ticketEvents.append({ ...e("other", 5), ticketId: "t2" });
  // A second same-ms pair whose ids sort with insert order: together with b/a it pins the rowid
  // tie (ordering by id, either way, breaks one of the two pairs).
  await s.ticketEvents.append(e("c", 30));
  await s.ticketEvents.append(e("d", 30));
  const list = await s.ticketEvents.list("t1");
  expect(list.map((x) => x.id)).toEqual(["b", "a", "z", "c", "d"]);
  expect(list[0]).toEqual({
    id: "b",
    ticketId: "t1",
    kind: "assignee",
    from: "b1",
    to: "b2",
    actor: { kind: "bot", botId: "b1" },
    at: 10,
  });
  expect(list[1]).not.toHaveProperty("from");
});
