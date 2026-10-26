import { expect, test } from "bun:test";
import type { Bot, Group, Store } from "@friday/core";
import { KNOWN_MAX_CHARS, knownFor } from "../src/memory-known";

const dev = {
  id: "dev",
  instructions: "SOUL\n\nUSER\n\nDev writes code.",
  ownerPreface: "SOUL\n\nUSER",
};
const team = { id: "team", entryBot: "dev", instructions: "BE uses Prisma." };

/** A store over one bot and one group. */
const store = (bot: Partial<Bot> = dev, group: Partial<Group> = team) =>
  ({
    bots: { get: async (id: string) => (id === bot.id ? bot : undefined), list: async () => [bot] },
    groups: { get: async (id: string) => (id === group.id ? group : undefined) },
  }) as unknown as Pick<Store, "bots" | "groups">;

test("a bot's known is its instructions", async () => {
  expect(await knownFor(store(), { botId: "dev" })).toBe(dev.instructions);
});

test("a group's known is the entry bot's owner preface and the group's instructions", async () => {
  expect(await knownFor(store(), { groupId: "team" })).toBe("SOUL\n\nUSER\n\nBE uses Prisma.");
});

test("a bot in a group knows its instructions and the group's", async () => {
  expect(await knownFor(store(), { botId: "dev", groupId: "team" })).toBe(
    `${dev.instructions}\n\nBE uses Prisma.`,
  );
});

test("known is cut at the end to KNOWN_MAX_CHARS; nothing known is undefined", async () => {
  const long = { ...dev, instructions: `SOUL ${"x".repeat(9000)}` };
  const k = await knownFor(store(long), { botId: "dev" });
  expect(k?.length).toBe(KNOWN_MAX_CHARS);
  expect(k?.startsWith("SOUL ")).toBe(true);
  expect(await knownFor(store(), { botId: "nobody" })).toBeUndefined();
});
