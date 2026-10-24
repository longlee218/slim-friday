import { expect, test } from "bun:test";
import {
  mergeTimeline,
  relatedRefs,
  type Ticket,
  type TicketComment,
  type TicketEvent,
} from "../src";

const c = (id: string, at: number): TicketComment => ({
  id,
  ticketId: "t",
  author: { kind: "user" },
  body: id,
  createdAt: at,
});
const e = (id: string, at: number): TicketEvent => ({
  id,
  ticketId: "t",
  kind: "status",
  actor: { kind: "user" },
  at,
});
const t: Ticket = {
  id: "t",
  number: 1,
  title: "x",
  status: "todo",
  priority: "normal",
  createdBy: { kind: "user" },
  createdAt: 0,
  updatedAt: 0,
};
const cm = (body: string): TicketComment => ({ ...c("x", 1), body });

test("merges by time, events before comments at the same ms, stable otherwise", () => {
  const items = mergeTimeline([c("c1", 20), c("c2", 30)], [e("e1", 10), e("e2", 30), e("e3", 30)]);
  expect(items.map((i) => (i.kind === "comment" ? i.comment.id : i.event.id))).toEqual([
    "e1",
    "c1",
    "e2",
    "e3",
    "c2",
  ]);
});

test("relatedRefs: description then comments, unique, not itself", () => {
  expect(
    relatedRefs({ ...t, number: 21, description: "see FRI-22 and fri-21" }, [
      cm("FRI-23 and FRI-22"),
    ]),
  ).toEqual(["FRI-22", "FRI-23"]);
});
