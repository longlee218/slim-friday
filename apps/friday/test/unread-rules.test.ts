import { afterEach, expect, test } from "bun:test";
import { botFile, until, webHarness } from "./web-harness";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** Set by a test: called once during the next turn (a bot sending to another bot while it answers). */
let asker: (() => Promise<unknown>) | undefined;

/** The whole engine over the real engine store with bots ann, bob, cy and a group of ann and bob. */
async function boot() {
  const h = await webHarness({
    "bots/ann.md": botFile("Ann"),
    "bots/bob.md": botFile("Bob"),
    "bots/cy.md": botFile("Cy"),
    "groups/team.yaml": "name: Team\nmembers: [ann, bob]\nentryBot: ann\n",
  });
  stops.push(h.stop);
  // Every turn is answered with one final text.
  h.runtime.onTurn = (s) => {
    const ask = asker;
    asker = undefined;
    if (ask) void ask();
    s.emit({ type: "text", text: "final answer" });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  return h;
}

/** How many "final answer" bot messages are stored in the conversation. */
async function botFinals(h: Awaited<ReturnType<typeof boot>>, conv: string) {
  return (await h.store.messages.page(conv, { limit: 50 })).filter(
    (m) => m.author.kind === "bot" && m.text === "final answer",
  ).length;
}

/** Wait (polling the store) until `n` finals exist in the conversation. */
async function waitFinals(h: Awaited<ReturnType<typeof boot>>, conv: string, n: number) {
  for (let i = 0; i < 300; i++) {
    if ((await botFinals(h, conv)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`no ${n} finals in ${conv}`);
}

test("finals of ticket, intro and bot-to-bot runs are not unread; an owner final is", async () => {
  const h = await boot();
  const before = {
    cy: await h.store.reads.unread("bot:cy"),
    bob: await h.store.reads.unread("bot:bob"),
    ann: await h.store.reads.unread("bot:ann"),
  };
  // A ticket run (assignee cy, in its direct chat).
  const t = await h.hub.tickets.create({ kind: "user" }, { title: "T", assigneeBotId: "cy" });
  if (!t.ok) throw new Error(t.error);
  // The fake bot never updates the ticket, so it is re-woken once and then blocked with a system notice;
  // wait for that notice (a system message still counts as unread) and for the two finals.
  await waitFinals(h, "bot:cy", 2);
  await until(() => false, 300).catch(() => {});
  const cy = await h.store.messages.page("bot:cy", { limit: 50 });
  expect(cy.some((m) => m.author.kind === "system")).toBe(true);
  expect(await h.store.reads.unread("bot:cy")).toBe(before.cy + 1);
  // An intro run (bob's direct chat).
  await h.hub.queueIntroRun("bob");
  await waitFinals(h, "bot:bob", 1);
  expect(await h.store.reads.unread("bot:bob")).toBe(before.bob);
  // A bot-to-bot run: the owner writes to the group, ann answers and, during that turn, asks bob.
  asker = () => h.hub.send("ann@team", { to: "bob", text: "please check", intent: "request" });
  await h.client.chat.send({ conversationId: "group:team", text: "team, go" });
  for (let i = 0; i < 300 && (await botFinals(h, "group:team")) < 2; i++) await Bun.sleep(10);
  const team = await h.store.messages.page("group:team", { limit: 50 });
  const bobFinal = team.find((m) => m.author.kind === "bot" && m.author.botId === "bob");
  expect((await h.store.wakes.get(bobFinal?.wakeId ?? ""))?.sender.kind).toBe("bot");
  // Counted: the "Group ready" notice, ann's answer to the owner and her relay line. Not counted: bob's
  // answer to ann, and ann's follow-up run that receives bob's result (both runs started by a bot).
  expect(await h.store.reads.unread("group:team")).toBe(3);
  // An owner run: its final counts, and the owner's own message does not.
  await h.client.chat.send({ conversationId: "bot:ann", text: "hi" });
  await waitFinals(h, "bot:ann", 1);
  expect(await h.store.reads.unread("bot:ann")).toBe(before.ann + 1);
  // A system notice still counts.
  await h.store.messages.append({
    conversationId: "bot:ann",
    author: { kind: "system" },
    text: "notice",
    at: 1,
  });
  expect(await h.store.reads.unread("bot:ann")).toBe(before.ann + 2);
});
