import { expect, test } from "bun:test";
import { CORE_DEFAULTS } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const notices = (posts: { message: { author: { kind: string }; text: string } }[]) =>
  posts.filter((p) => p.message.author.kind === "system").map((p) => p.message.text);

test("two bots that @ each other stop at maxHops with exactly one notice", async () => {
  const { runtime, surface } = makeHub();
  runtime.onTurn = (session, turn) => {
    const other = session.spec.bot.id === "writer" ? "editor" : "writer";
    session.emit({ type: "text", text: `@${other} ping ${turn.hop}` });
  };
  surface.deliver({ conversationId: "gc", text: "start" });
  await flush();
  await flush();
  const turns = runtime.all().flatMap((s) => s.sent);
  expect(Math.max(...turns.map((t) => t.hop))).toBe(CORE_DEFAULTS.maxHops);
  expect(notices(surface.posts)).toEqual(["Stopped: hops limit reached."]);
});

test("spend over the daily cap refuses the next wake once; the next day works again", async () => {
  const { runtime, surface, clock } = makeHub();
  surface.deliver({ conversationId: "dc", text: "one" });
  await flush();
  runtime.opened[0]?.emit({ type: "turn_end", costUsd: CORE_DEFAULTS.maxSpendPerBotPerDayUsd });
  await flush();
  surface.deliver({ conversationId: "dc", text: "two" });
  await flush();
  expect(runtime.opened[0]?.sent).toHaveLength(1);
  expect(notices(surface.posts)).toEqual(["Stopped: spend limit reached."]);
  clock.advance(86_400_000);
  surface.deliver({ conversationId: "dc", text: "four" });
  await flush();
  expect(runtime.opened[0]?.sent).toHaveLength(2);
});

test("a bot repeating the same hand-off inside the window is not delivered twice", async () => {
  const { runtime, surface } = makeHub();
  surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  const writer = runtime.nth(0);
  writer.emit({ type: "text", text: "@editor check" });
  await flush();
  writer.emit({ type: "text", text: "@editor check" });
  await flush();
  const editorTurns = runtime
    .all()
    .filter((s) => s.spec.bot.id === "editor")
    .flatMap((s) => s.sent);
  expect(editorTurns).toHaveLength(1);
});
