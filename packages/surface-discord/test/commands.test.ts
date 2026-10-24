import { expect, test } from "bun:test";
import { DiscordSurface } from "../src/discord-surface";
import { FakeDiscordPort } from "./fake-discord-port";

function setup(
  handler: (c: { conversationId: string; name: string; botName?: string }) => Promise<string>,
) {
  const port = new FakeDiscordPort();
  const surface = new DiscordSurface(port, () => undefined);
  surface.onCommand(handler as never);
  return { port };
}

test("the owner's command gets the handler's text", async () => {
  const seen: unknown[] = [];
  const { port } = setup(async (c) => {
    seen.push(c);
    return "3 bots";
  });
  expect(await port.emitCommand({ channelId: "ch1", name: "stop", botName: "ann" })).toEqual([
    "3 bots",
  ]);
  expect(seen).toEqual([{ conversationId: "ch1", name: "stop", botName: "ann" }]);
});

test("someone else is refused and the handler is not called", async () => {
  let called = false;
  const { port } = setup(async () => {
    called = true;
    return "x";
  });
  expect(await port.emitCommand({ channelId: "ch1", name: "status" }, "stranger")).toEqual([
    "Only the owner can do that.",
  ]);
  expect(called).toBe(false);
});

test("a throwing handler replies with the failure", async () => {
  const { port } = setup(async () => {
    throw new Error("boom");
  });
  expect(await port.emitCommand({ channelId: "ch1", name: "status" })).toEqual(["Failed: boom"]);
});
