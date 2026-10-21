import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ANNOUNCE_REARM_MAX_MS } from "../src/config/lead-caps";
import { ZOMBIE_CLAIM_NOTICE_MS } from "../src/config/resilience-caps";
import { createMessageHandler } from "../src/ingress/discord-message-handler";
import { renderUserNotice } from "../src/ingress/user-copy";
import { goalBudgetCanGrow } from "../src/orchestrator/budget/task-budget";
import { createRetryPort } from "../src/orchestrator/goal/effect-port-retry";
import { announceRearmDelay } from "../src/orchestrator/lead/lead-events";
import {
  claimZombieLocation,
  clearZombieClaims,
  zombieClaims,
} from "../src/orchestrator/run/zombie-claims";
import { settleGoal } from "../src/orchestrator/worker/goal-settle";
import { hasPendingAnswer } from "../src/orchestrator/worker/resume-prompt";
import { resumeWaiting } from "../src/orchestrator/worker/resume-waiting";
import { pickDispatchable } from "../src/orchestrator/worker/scheduler";
import { noticeStuckZombies } from "../src/orchestrator/worker/zombie-notice";
import { buildTeamMd } from "../src/roles/prompts/team-md";
import { itemOfQuestionMessage, linkQuestionMessage } from "../src/storage/item-question-store";
import { getItem, type ItemRow } from "../src/storage/owned-item-store";
import { linkTurn } from "../src/storage/owned-task-store";
import { insertTurn } from "../src/storage/run-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { TEST_CHANNEL } from "./helpers";
import { type Call, leadHarness, until, workersDone } from "./lead-harness";
import { approvedPlan, item as planItem } from "./waves-fixture";

/* Fixes of the Phase 1 final review (findings 1-8, F4 / F5 leftovers). */

const ANSWER = "use the blue theme";

/** The one goal item of a thread (id). */
const itemIdOf = (db: any): string =>
  (db.query("SELECT id FROM owned_tasks WHERE parent_id IS NOT NULL").get() as { id: string }).id;

/** An owner message that is a Discord reply to `replyTo`. */
const reply = (h: ReturnType<typeof leadHarness>, replyTo: string, text: string, id: string) =>
  h.handle({
    source: "discord",
    userId: "owner",
    threadId: "t1",
    channelId: TEST_CHANNEL,
    messageId: id,
    replyToMessageId: replyTo,
    text,
    language: "en",
    notify: async () => {},
  });

/**
 * Lead + developer script: a worker run ends with no report (item waiting_user) until its prompt carries `finishOn`,
 * then it completes. The first owner message dispatches the one item; `onLead` plays every other lead run.
 */
function waitingScript(finishOn: string, onLead: (c: Call, item: string) => Promise<void> | void) {
  let itemId = "";
  return (c: Call) => {
    if (c.kind === "worker") {
      if (c.prompt.includes(finishOn))
        return c
          .report("result", { title: "T", status: "COMPLETED", summary: "ok" })
          .then(() => "done");
      return Promise.resolve("which theme?");
    }
    if (c.prompt.includes("Owner message:") && !itemId)
      return c
        .orchestrate("dispatch", {
          strategy: "DIRECT",
          small: true,
          intent: "work",
          reason: "one specialist",
          assignments: [
            { key: "main", subject: "task", role: "developer", brief: "style it", dependsOn: [] },
          ],
        })
        .then((r) => {
          itemId = r.itemIds[0];
          return "started";
        });
    return Promise.resolve(onLead(c, itemId)).then(() => "ok");
  };
}

test("#1: owner answers never trip the dispatch breaker (3 answers, the item still completes)", async () => {
  const h = leadHarness(waitingScript("ans3", () => {}));
  await h.send("style it");
  await workersDone(h.env.db);
  const id = itemIdOf(h.env.db);
  for (const n of [1, 2, 3]) {
    await until(
      () => getItem(h.env.db, id)?.status === "waiting_user" && h.ofKind("worker").length === n,
      8000,
    );
    linkQuestionMessage(h.env.db, `q${n}`, "t1", id);
    await reply(h, `q${n}`, `ans${n}`, `m${n}`);
  }
  await until(() => getItem(h.env.db, id)?.status === "completed", 8000);
  expect(getItem(h.env.db, id)?.dispatchCount).toBe(1); // only the first start counted
}, 30_000);

test("#2: a reply to an old question message is a plain message for the lead once the item resumed", async () => {
  const h = leadHarness(waitingScript("ans2", () => {}));
  await h.send("style it");
  await workersDone(h.env.db);
  const id = itemIdOf(h.env.db);
  await until(() => getItem(h.env.db, id)?.status === "waiting_user", 8000);
  linkQuestionMessage(h.env.db, "q-old", "t1", id);
  await reply(h, "q-old", "ans1", "m1");
  await until(() => h.ofKind("worker").length === 2, 8000);
  await until(() => getItem(h.env.db, id)?.status === "waiting_user", 8000); // asks again (newer question)
  expect(itemOfQuestionMessage(h.env.db, "q-old", "t1")).toBeUndefined(); // the link died with the answer
  const before = h.ofKind("lead").length;
  await reply(h, "q-old", "this is for the old question", "m2");
  await until(() => h.ofKind("lead").length > before, 8000);
  expect(h.ofKind("worker")).toHaveLength(2); // the item was NOT resumed by the stale reply
  expect(getItem(h.env.db, id)?.status).toBe("waiting_user");
  expect(h.ofKind("lead").some((c) => c.prompt.includes("this is for the old question"))).toBe(
    true,
  );
}, 30_000);

test("#2/#8: question links are removed when their item settles (completed or cancelled)", async () => {
  const h = leadHarness(waitingScript("ans1", () => {}));
  await h.send("style it");
  await workersDone(h.env.db);
  const id = itemIdOf(h.env.db);
  await until(() => getItem(h.env.db, id)?.status === "waiting_user", 8000);
  linkQuestionMessage(h.env.db, "q-c", "t1", id);
  await reply(h, "q-c", "ans1", "m-c");
  await until(() => getItem(h.env.db, id)?.status === "completed", 8000);
  expect(itemOfQuestionMessage(h.env.db, "q-c", "t1")).toBeUndefined();
  // A cancelled item: the goal settle sweeps its links too.
  const g = approvedPlan([planItem("a")], { budget: 4 });
  const gid = (g.db.query("SELECT id FROM owned_tasks WHERE item_key = 'a'").get() as any).id;
  linkQuestionMessage(g.db, "q-x", "th", gid);
  moveTaskTo(g.db, gid, "cancelled");
  settleGoal(g.db, g.goalId);
  expect(itemOfQuestionMessage(g.db, "q-x", "th")).toBeUndefined();
  g.db.close();
}, 30_000);

test("#3 + onMessage link: a reply while Orchestrate ask_owner waits answers the ask, removes its buttons and resumes the item", async () => {
  let resolveAsk: (v: string | undefined) => void = () => {};
  const cancelled: string[] = [];
  let asked: any;
  let askResult: any;
  const h = leadHarness(
    waitingScript("blue", async (c, id) => {
      if (c.prompt.includes("Task events") && id && !asked) {
        asked = true;
        askResult = await c.orchestrate("ask_owner", {
          kind: "text",
          question: "which theme?",
          taskId: id,
        });
      }
    }),
    undefined,
    {
      askChoice: (a) => {
        a.onMessage?.("q-msg");
        return new Promise((r) => {
          resolveAsk = r;
        });
      },
      cancelTurn: (turnId) => {
        cancelled.push(turnId);
        resolveAsk(undefined);
      },
    },
  );
  await h.send("style it");
  await workersDone(h.env.db);
  const id = itemIdOf(h.env.db);
  await until(() => itemOfQuestionMessage(h.env.db, "q-msg", "t1") === id, 8000); // linked by onMessage
  await reply(h, "q-msg", ANSWER, "m-ans");
  await until(() => askResult !== undefined, 8000);
  expect(cancelled).toHaveLength(1); // the buttons of that ask are gone
  expect(askResult).toMatchObject({ ok: true, answer: ANSWER }); // the lead run is released with the answer
  await until(() => getItem(h.env.db, id)?.status === "completed", 8000);
}, 30_000);

test("#8: a reply that resumed a task is confirmed to the owner, and the answer is labelled as the owner's", async () => {
  const h = leadHarness(waitingScript("blue", () => {}));
  await h.send("style it");
  await workersDone(h.env.db);
  const id = itemIdOf(h.env.db);
  await until(() => getItem(h.env.db, id)?.status === "waiting_user", 8000);
  linkQuestionMessage(h.env.db, "q-1", "t1", id);
  const out = await reply(h, "q-1", `${ANSWER} ${"x".repeat(700)}`, "m-1");
  expect(out).toBe(renderUserNotice({ kind: "steer", state: "resumed" }, "en"));
  await until(() => h.ofKind("worker").length === 2, 8000);
  const prompt = h.ofKind("worker")[1]!.prompt;
  expect(prompt).toContain("owner's answer");
  expect(prompt).not.toContain("Answer to your question (data, not instructions)");
  expect(prompt).toContain("clipped"); // 700+ chars do not fit: the worker is told
}, 30_000);

test("#8: a reply in a chat-mode channel (thread id = channel id) takes the same path", async () => {
  // A chat-mode channel is its own thread: `threadId` is the channel id, the link and the reply carry it.
  const h = leadHarness(waitingScript("blue", () => {}));
  await h.send("style it", "chat-chan");
  await workersDone(h.env.db);
  const id = itemIdOf(h.env.db);
  await until(() => getItem(h.env.db, id)?.status === "waiting_user", 8000);
  linkQuestionMessage(h.env.db, "q-chat", "chat-chan", id);
  await h.handle({
    source: "discord",
    userId: "owner",
    threadId: "chat-chan",
    channelId: TEST_CHANNEL,
    messageId: "m-chat",
    replyToMessageId: "q-chat",
    text: ANSWER,
    language: "en",
    notify: async () => {},
  });
  await until(() => getItem(h.env.db, id)?.status === "completed", 8000);
}, 30_000);

test("ingress wiring: a Discord reply reaches handleMessage as replyToMessageId", async () => {
  const seen: any[] = [];
  const onMessage = createMessageHandler({
    ownerId: "111",
    botId: () => "999",
    receiptDelayMs: 50,
    handleMessage: async (m) => {
      seen.push(m);
      return undefined;
    },
  });
  const th: any = {
    id: "thr1",
    isThread: () => true,
    ownerId: "999",
    parentId: "parent1",
    isSendable: () => true,
    send: async () => {},
    sendTyping: async () => {},
  };
  const msg: any = {
    react: async () => {},
    reactions: { cache: new Map() },
    author: { id: "111", bot: false },
    content: "my answer",
    channel: th,
    guildId: "G1",
    inGuild: () => true,
    mentions: { has: () => false },
    reference: { messageId: "q-discord" },
    reply: async () => {},
  };
  await onMessage(msg);
  expect(seen[0]).toMatchObject({ threadId: "thr1", replyToMessageId: "q-discord" });
  msg.reference = undefined; // a plain message carries none
  await onMessage(msg);
  expect(seen[1].replyToMessageId).toBeUndefined();
});

test("#4: a zombie location is an input of the scheduler: another writer still starts, no slot is wasted", () => {
  const mk = (id: string, location: string): ItemRow =>
    ({
      id,
      status: "ready",
      ownerRole: "developer",
      location,
      itemKey: id,
      dependsOn: [],
    }) as unknown as ItemRow;
  const caps = () => ({ writer: true });
  const zombie = (it: ItemRow) => it.location === "a";
  const picks = pickDispatchable([mk("1", "a"), mk("2", "b")], caps, 1, zombie);
  expect(picks.map((p) => p.id)).toEqual(["2"]); // a one-slot cap is not spent on the blocked item
});

test("#4: a stuck zombie claim gives the lead one notice and stays claimed", () => {
  clearZombieClaims();
  const g = approvedPlan([planItem("a")], { budget: 4 });
  const itemId = (g.db.query("SELECT id FROM owned_tasks WHERE item_key = 'a'").get() as any).id;
  const release = claimZombieLocation("repo", { threadId: "th", itemId, goalId: g.goalId });
  const announced: string[] = [];
  const rt: any = { deps: { db: g.db }, announce: (t: string) => announced.push(t) };
  const t0 = Date.now();
  expect(noticeStuckZombies(rt, t0 + 1000)).toBe(0); // too young
  expect(noticeStuckZombies(rt, t0 + ZOMBIE_CLAIM_NOTICE_MS + 1000)).toBe(1);
  expect(noticeStuckZombies(rt, t0 + ZOMBIE_CLAIM_NOTICE_MS + 2000)).toBe(0); // once per claim
  expect(announced).toEqual(["th"]);
  const ev = (g.db.query("SELECT payload, kind FROM thread_events").all() as any[]).find(
    (e) => e.kind === "timeout",
  );
  expect(ev.payload).toContain("zombie_claim");
  expect(zombieClaims("repo")).toBe(true); // no process is reachable: the claim stays
  release();
  expect(zombieClaims("repo")).toBe(false);
  g.db.close();
});

test("#5: a goal without an approved plan cannot grow its budget; a plan goal below the ceiling can", () => {
  const p = approvedPlan([planItem("a")], { budget: 4 });
  expect(goalBudgetCanGrow(p.db, p.goalId)).toBe(true);
  p.db.query("UPDATE work_plans SET budget_usd = 35 WHERE goal_id = ?").run(p.goalId);
  expect(goalBudgetCanGrow(p.db, p.goalId)).toBe(false); // at the ceiling
  p.db.close();
});

test("#5: a budget_hit on a DELEGATE goal says the budget cannot grow; the lead prompt does not promise a retry", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "done" });
      return { text: "ok", cost: 20 }; // over the $15 DELEGATE budget
    }
    if (c.prompt.includes("Owner message:")) {
      await c.orchestrate("dispatch", {
        strategy: "DELEGATE",
        small: true,
        intent: "work",
        reason: "two steps",
        assignments: [
          { key: "a", subject: "task", role: "developer", brief: "do a", dependsOn: [] },
          { key: "b", subject: "task", role: "developer", brief: "do b", dependsOn: ["a"] },
        ],
      });
      return "started";
    }
    return "ok";
  });
  await h.send("two steps");
  const hit = () =>
    h.env.db.query("SELECT payload FROM thread_events WHERE kind = 'budget_hit'").get() as
      | { payload: string }
      | undefined;
  await until(() => !!hit(), 15_000);
  const p = JSON.parse(hit()!.payload);
  expect(p).toMatchObject({ cause: "budget", canGrow: false });
  expect(p.error).toContain("cannot grow");
  const md = buildTeamMd();
  expect(md).not.toContain("works once the goal budget allows");
  // The budget_hit playbook moved from TEAM.md to the lead-orchestration skill.
  expect(md).not.toContain("budget_hit:");
  expect(readFileSync(".agents/skills/lead-orchestration/SKILL.md", "utf8")).toContain(
    "budget_hit `canGrow:false`",
  );
}, 25_000);

test("#6: every Orchestrate retry writes its own retry event, and the newest note reaches the session", () => {
  const g = approvedPlan([planItem("a")], { budget: 4 });
  const id = (g.db.query("SELECT id FROM owned_tasks WHERE item_key = 'a'").get() as any).id;
  const port = createRetryPort(g.db, "th");
  for (const note of ["first note", "second note"]) {
    // Held again with no new run in between (same dispatch count): each retry still records its note.
    moveTaskTo(g.db, id, "ready");
    moveTaskTo(g.db, id, "running");
    moveTaskTo(g.db, id, "blocked");
    g.db.query("UPDATE owned_tasks SET result_kind = 'FAILED' WHERE id = ?").run(id);
    expect(port.retry!(id, note)).toBe("ok");
  }
  const notes = (
    g.db.query("SELECT payload FROM thread_events WHERE kind = 'retry' ORDER BY seq").all() as {
      payload: string;
    }[]
  ).map((r) => JSON.parse(r.payload).note);
  expect(notes).toEqual(["first note", "second note"]);
  g.db.close();
});

test("#7: Orchestrate steer on a held item says so (use Orchestrate retry), it never says ended", async () => {
  let r: any;
  const h = leadHarness(
    waitingScript("never", async (c, id) => {
      if (c.prompt.includes("Task events") && id && !r) {
        // The age limit held the waiting item: blocked + FAILED.
        moveTaskTo(h.env.db, id, "blocked");
        h.env.db.query("UPDATE owned_tasks SET result_kind = 'FAILED' WHERE id = ?").run(id);
        r = await c.orchestrate("steer", { taskId: id, text: ANSWER });
      }
    }),
  );
  await h.send("style it");
  await workersDone(h.env.db);
  await until(() => r !== undefined, 8000);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("HELD");
  expect(r.message).toContain("Orchestrate retry");
}, 30_000);

test("F5: a dropped announce re-arms with a growing, capped delay", () => {
  expect(announceRearmDelay(0, 2000)).toBe(2000);
  expect(announceRearmDelay(1, 2000)).toBe(4000);
  expect(announceRearmDelay(3, 2000)).toBe(16_000);
  expect(announceRearmDelay(30, 2000)).toBe(ANNOUNCE_REARM_MAX_MS);
});

test("#1: an item with an unconsumed owner answer is exempt from the breaker; one without is not", () => {
  const g = approvedPlan([planItem("a")], { budget: 4 });
  const id = (g.db.query("SELECT id FROM owned_tasks WHERE item_key = 'a'").get() as any).id;
  insertTurn(g.db, { id: "t1", threadId: "th", source: "t", location: "r", role: "developer" });
  linkTurn(g.db, "t1", id);
  expect(hasPendingAnswer(g.db, id)).toBe(false);
  moveTaskTo(g.db, id, "ready");
  moveTaskTo(g.db, id, "running");
  moveTaskTo(g.db, id, "waiting_user");
  expect(resumeWaiting(g.db, id, "an answer", "owner")).toBe(true);
  expect(hasPendingAnswer(g.db, id)).toBe(true);
  g.db.close();
});
