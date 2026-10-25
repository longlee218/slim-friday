import { expect, test } from "bun:test";
import type { Schedule } from "../../src";
import { type HubContext, tell } from "../../src/hub/hub-context";
import { createRun } from "../../src/runs/run-create";
import { flush, makeHub } from "../bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;
/** The hub's shared context (a test creates runs the way the schedule board does). */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;

/** A schedule of editor in its direct chat. */
const sched: Schedule = {
  id: "s1",
  name: "Morning brief",
  botId: "editor",
  task: "Write the brief.",
  rule: { kind: "daily", at: "07:30" },
  timeZone: "UTC",
  conversationId: "dc",
  notify: "always",
  enabled: true,
  nextRunAt: 1000,
  createdBy: { kind: "user" },
  createdAt: 1,
  updatedAt: 1,
};

/** Run one scheduled turn of editor that answers `text`; returns the messages it posted. */
async function scheduledTurn(h: Hub, text: string, quiet = false) {
  await createRun(ctxOf(h), {
    botId: "editor",
    conversationId: "dc",
    sender: { kind: "system" },
    text: sched.task,
    hop: 0,
    opts: { schedule: { id: sched.id, quiet } },
  });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "text", text });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  return h.surface.posts.map((p) => p.message);
}

test("a scheduled run's answer carries the schedule id and name, stored and posted", async () => {
  const h = makeHub();
  await h.store.schedules.insert(sched);
  const [posted] = await scheduledTurn(h, "Here is the brief.");
  expect(posted).toMatchObject({ scheduleId: "s1", scheduleName: "Morning brief" });
  const stored = posted && (await h.store.messages.get(posted.id));
  expect(stored).toMatchObject({ scheduleId: "s1", scheduleName: "Morning brief" });
});

test("a schedule deleted before its run posts keeps the id, without a name", async () => {
  const h = makeHub();
  const [posted] = await scheduledTurn(h, "Here is the brief.");
  expect(posted?.scheduleId).toBe("s1");
  expect(posted?.scheduleName).toBeUndefined();
});

test("a quiet scheduled run that has nothing to say still posts nothing", async () => {
  const h = makeHub();
  await h.store.schedules.insert(sched);
  expect(await scheduledTurn(h, "NO_RESPONSE", true)).toEqual([]);
});

test("an owner run's answer and a system notice carry no schedule tag", async () => {
  const h = makeHub();
  await h.store.schedules.insert(sched);
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "text", text: "Hello." });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  await tell(ctxOf(h), "dc", "A notice.");
  const posts = h.surface.posts.map((p) => p.message);
  expect(posts.map((m) => m.text)).toEqual(["Hello.", "A notice."]);
  for (const m of posts) {
    expect(m.scheduleId).toBeUndefined();
    expect(m.scheduleName).toBeUndefined();
  }
});
