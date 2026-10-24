import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { bot, flush, makeHub } from "./bot-hub-harness";

/** Start a group chain: the user writes in the group, the entry bot (writer) is running a turn. */
async function started() {
  const h = makeHub();
  h.surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  return h;
}
const req = (to: string, text = "check", extra = {}) => ({
  to,
  text,
  intent: "request" as const,
  ...extra,
});

test("send wakes the target with hop + 1 and the sender's running wake as parent", async () => {
  const { hub, runtime, store } = await started();
  const r = await hub.send("writer@g", req("editor"));
  await flush();
  expect(r.ok).toBe(true);
  const turn = runtime.opened[1]?.sent[0];
  expect(runtime.opened[1]?.spec.bot.id).toBe("editor");
  expect(turn).toMatchObject({
    conversationId: "gc",
    hop: 1,
    text: "check",
    intent: "request",
    from: { kind: "bot", botId: "writer" },
  });
  const [first, second] = [...store.wakeMap.values()];
  expect(second).toMatchObject({ parentWakeId: first?.id, chainId: first?.id, hop: 1 });
});

test("send accepts the target by name, in any case", async () => {
  const { hub } = await started();
  expect((await hub.send("writer@g", req("EDITOR"))).ok).toBe(true);
});

test("send is refused for itself, a non-member, an unknown name and a direct chat", async () => {
  const { hub, store, surface } = await started();
  store.botMap.set("ghost", bot("ghost", "Ghost"));
  const err = async (to: string) => {
    const r = await hub.send("writer@g", req(to));
    return r.ok ? "ok" : r.error;
  };
  expect(await err("writer")).toContain("itself");
  expect(await err("ghost")).toContain("No member");
  expect(await err("nobody")).toContain("No member");
  surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const r = await hub.send("editor", req("writer"));
  expect(r.ok ? "ok" : r.error).toContain("group");
});

test("send past the hop limit is refused with a reason the bot can read", async () => {
  const { hub, runtime, surface } = makeHub();
  const results: { ok: boolean; error?: string }[] = [];
  runtime.onTurn = (session, turn) => {
    const other = session.spec.bot.id === "writer" ? "editor" : "writer";
    void hub
      .send(session.spec.sessionKey ?? "", req(other, `ping ${turn.hop}`))
      .then((r) => results.push(r));
    session.emit({ type: "turn_end", costUsd: 0 });
  };
  surface.deliver({ conversationId: "gc", text: "start" });
  await flush();
  await flush();
  const hops = runtime.all().flatMap((s) => s.sent.map((t) => t.hop));
  expect(Math.max(...hops)).toBe(CORE_DEFAULTS.maxHops);
  const refused = results.find((r) => !r.ok);
  expect(refused?.error).toContain("limit");
});

test("a result to the bot that gave the work passes the hop limit", async () => {
  const { hub, runtime, surface } = makeHub();
  const results: { ok: boolean }[] = [];
  runtime.onTurn = (session, turn) => {
    const other = session.spec.bot.id === "writer" ? "editor" : "writer";
    const m =
      turn.hop < CORE_DEFAULTS.maxHops
        ? req(other, `ping ${turn.hop}`)
        : { to: other, text: "all done", intent: "result" as const };
    if (turn.hop <= CORE_DEFAULTS.maxHops)
      void hub.send(session.spec.sessionKey ?? "", m).then((r) => results.push(r));
    session.emit({ type: "turn_end", costUsd: 0 });
  };
  surface.deliver({ conversationId: "gc", text: "start" });
  await flush();
  await flush();
  const last = runtime
    .all()
    .flatMap((s) => s.sent)
    .find((t) => t.hop === CORE_DEFAULTS.maxHops + 1);
  expect(last).toMatchObject({ intent: "result", text: "all done" });
  expect(results.every((r) => r.ok)).toBe(true);
});

test("HandOff to the sender of the running wake is refused", async () => {
  const { hub } = await started();
  await hub.send("writer@g", req("editor"));
  await flush();
  const r = await hub.send("editor@g", req("writer", "back to you", { handoff: true }));
  expect(r.ok ? "ok" : r.error).toContain("hand");
});

test("when a turn woken by a request ends, its last text goes back as a result", async () => {
  const { hub, runtime, store } = await started();
  await hub.send("writer@g", req("editor"));
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const editor = runtime.nth(1);
  editor.emit({ type: "text", text: "first thought" });
  editor.emit({ type: "text", text: "done: cut 1" });
  editor.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const back = runtime.nth(0).sent[1];
  expect(back).toMatchObject({ intent: "result", text: "done: cut 1", hop: 2 });
  expect(back?.from).toEqual({ kind: "bot", botId: "editor" });
  expect([...store.wakeMap.values()].at(-1)?.parentWakeId).toBeDefined();
});

test("no automatic result when the bot already sent a result to that sender", async () => {
  const { hub, runtime } = await started();
  await hub.send("writer@g", req("editor"));
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  const editor = runtime.nth(1);
  await hub.send("editor@g", { to: "writer", text: "explicit result", intent: "result" });
  editor.emit({ type: "text", text: "closing words" });
  editor.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(runtime.nth(0).sent.map((t) => t.text)).toEqual(["go", "explicit result"]);
});

test("an fyi never triggers an automatic result", async () => {
  const { hub, runtime } = await started();
  await hub.send("writer@g", { to: "editor", text: "FYI", intent: "fyi" });
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  runtime.nth(1).emit({ type: "text", text: "noted" });
  runtime.nth(1).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(runtime.nth(0).sent).toHaveLength(1);
});

test("a wake created by HandOff gets no automatic result", async () => {
  const { hub, runtime, store } = await started();
  await hub.send("writer@g", req("editor", "you own this", { handoff: true }));
  await flush();
  runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(runtime.nth(1).sent[0]).toMatchObject({ handoff: true });
  expect([...store.wakeMap.values()].at(-1)?.handoff).toBe(true);
  runtime.nth(1).emit({ type: "text", text: "finished" });
  runtime.nth(1).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(runtime.nth(0).sent).toHaveLength(1);
});

test("the sent message is posted to the channel under the sender's name and stored", async () => {
  const { hub, surface, store } = await started();
  await hub.send("writer@g", req("editor", "please cut the intro"));
  const post = surface.posts.at(-1);
  expect(post?.conversationId).toBe("gc");
  expect(post?.message.author).toEqual({ kind: "bot", botId: "writer" });
  expect(post?.message).toMatchObject({
    kind: "relay",
    text: "please cut the intro",
    relay: { fromBotId: "writer", toBotId: "editor", intent: "request" },
  });
  expect(store.msgs.at(-1)).toMatchObject({ kind: "relay", text: "please cut the intro" });
});

test("a bot's text with an @mention no longer wakes anyone", async () => {
  const { runtime } = await started();
  runtime.nth(0).emit({ type: "text", text: "@editor please check" });
  await flush();
  expect(runtime.opened).toHaveLength(1);
});

test("the same message twice inside the window is refused the second time", async () => {
  const { hub, runtime } = await started();
  expect((await hub.send("writer@g", req("editor"))).ok).toBe(true);
  const second = await hub.send("writer@g", req("editor"));
  expect(second.ok ? "ok" : second.error).toContain("repeat");
  await flush();
  expect(runtime.all().filter((s) => s.spec.bot.id === "editor")).toHaveLength(1);
});
