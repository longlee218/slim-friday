import { expect, test } from "bun:test";
import type { FileConfig } from "@friday/config";
import type { BotHub, ConfigChange, Group } from "@friday/core";
import { watchConfigReload } from "../src/config-reload";

const team: Group = {
  id: "team",
  name: "Team",
  members: ["atlas", "scout"],
  entryBot: "atlas",
  workspaces: [],
  instructions: "",
};

/** Drive one reload of `changed` bots and groups; resolves with the scopes the hub was told to reset. */
async function resetOf(changedBots: string[], changedGroups: string[]): Promise<string[]> {
  let fire: (r: unknown) => void = () => {};
  const config = {
    watch: (cb: (r: unknown) => void) => {
      fire = cb;
      return () => {};
    },
    groupIdsOf: (id: string) => (team.members.includes(id) ? ["team"] : []),
  } as unknown as FileConfig;
  let change: ConfigChange | undefined;
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => {
    done = r;
  });
  watchConfigReload({
    config,
    hub: {
      configChanged: async (c: ConfigChange) => {
        change = c;
      },
      queueIntroRun: async () => {},
    } as unknown as BotHub,
    store: {
      bots: { get: async () => ({}) },
      groups: { get: async (id: string) => (id === "team" ? team : undefined) },
    } as never,
    sync: async () => [],
    onConfigChanged: done,
    log: { warn() {}, error() {}, info() {} } as never,
  });
  fire({ problems: [], changedBots, changedGroups });
  await finished;
  return change?.resetScopes ?? [];
}

test("a changed bot resets its ticket scopes", async () => {
  expect(await resetOf(["atlas"], [])).toEqual(["atlas", "atlas@team", "atlas#ticket@team"]);
});

test("a changed group resets its members' ticket scopes", async () => {
  expect((await resetOf([], ["team"])).sort()).toEqual(
    ["atlas@team", "atlas#ticket@team", "scout@team", "scout#ticket@team"].sort(),
  );
});
