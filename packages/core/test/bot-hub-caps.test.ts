import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const notices = (posts: { message: { author: { kind: string }; text: string } }[]) =>
  posts.filter((p) => p.message.author.kind === "system").map((p) => p.message.text);

test("two bots that message each other stop at maxHops; the last message is refused with a reason", async () => {
  const { runtime, surface, hub } = makeHub();
  const results: { ok: boolean; error?: string }[] = [];
  runtime.onTurn = (session, turn) => {
    const other = session.spec.bot.id === "writer" ? "editor" : "writer";
    void hub
      .send(session.spec.sessionKey ?? "", {
        to: other,
        text: `ping ${turn.hop}`,
        intent: "request",
      })
      .then((r) => results.push(r));
    session.emit({ type: "turn_end", costUsd: 0 });
  };
  surface.deliver({ conversationId: "gc", text: "start" });
  await flush();
  await flush();
  const turns = runtime.all().flatMap((s) => s.sent);
  expect(Math.max(...turns.map((t) => t.hop))).toBe(CORE_DEFAULTS.maxHops);
  expect(results.filter((r) => !r.ok)).toHaveLength(1);
});

test("spend over the daily cap refuses the next wake once; the next day works again", async () => {
  const { runtime, surface, clock } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.opened[0]?.emit({ type: "turn_end", costUsd: CORE_DEFAULTS.maxSpendPerBotPerDayUsd });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.turns()).toHaveLength(1);
  expect(notices(surface.posts)).toEqual(["Stopped: spend limit reached."]);
  clock.advance(86_400_000);
  surface.deliver({ conversationId: "dc", text: "four" });
  await flush();
  expect(runtime.turns().map((t) => t.text)).toEqual(["one", "four"]);
});

test("a bot repeating the same message inside the window is not delivered twice, with one notice", async () => {
  const { runtime, surface, hub } = makeHub();
  surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  const send = () => hub.send("writer@g", { to: "editor", text: "check", intent: "request" });
  await send();
  await send();
  await flush();
  const editorTurns = runtime
    .all()
    .filter((s) => s.spec.bot.id === "editor")
    .flatMap((s) => s.sent);
  expect(editorTurns).toHaveLength(1);
  expect(notices(surface.posts)).toEqual(["Stopped: repeat limit reached."]);
});
