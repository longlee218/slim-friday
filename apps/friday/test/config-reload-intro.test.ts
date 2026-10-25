import { expect, test } from "bun:test";
import type { FileConfig } from "@friday/config";
import type { BotHub, Conversation } from "@friday/core";
import { watchConfigReload } from "../src/config-reload";

/** Drive one reload that created `created`; resolves with the bots that were asked to introduce themselves. */
async function reloadWith(created: Conversation[]): Promise<string[]> {
  const intros: string[] = [];
  let fire: (r: unknown) => void = () => {};
  const config = {
    watch: (cb: (r: unknown) => void) => {
      fire = cb;
      return () => {};
    },
    groupIdsOf: () => [],
  } as unknown as FileConfig;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });
  watchConfigReload({
    config,
    hub: {
      configChanged: async () => {},
      queueIntroRun: async (id: string) => void intros.push(id),
    } as unknown as BotHub,
    store: { bots: { get: async () => ({}) }, groups: { get: async () => undefined } } as never,
    sync: async () => created,
    onConfigChanged: done,
    log: { warn() {}, error() {}, info() {} } as never,
  });
  fire({ problems: [], changedBots: [], changedGroups: [] });
  await finished;
  return intros;
}

test("a reload that created a direct conversation queues that bot's intro run; groups get none", async () => {
  const intros = await reloadWith([
    { id: "bot:ann", kind: "direct", botId: "ann" },
    { id: "group:g", kind: "group", groupId: "g" },
  ]);
  expect(intros).toEqual(["ann"]);
});

test("a reload that created nothing queues no intro run", async () => {
  expect(await reloadWith([])).toEqual([]);
});
