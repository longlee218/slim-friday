import { expect, test } from "bun:test";
import { PermissionFlagsBits as P } from "discord.js";
import { privateOverwrites } from "../src/private-overwrites";

test("private overwrites: everyone denied, owner and app allowed with exact bits", () => {
  const o = privateOverwrites("g1", "owner1", "app1");
  expect(o).toHaveLength(3);
  expect(o.find((x) => x.id === "g1")).toEqual({ id: "g1", deny: [P.ViewChannel] });
  expect(o.find((x) => x.id === "owner1")).toEqual({
    id: "owner1",
    allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory],
  });
  expect(o.find((x) => x.id === "app1")).toEqual({
    id: "app1",
    allow: [
      P.ViewChannel,
      P.SendMessages,
      P.ReadMessageHistory,
      P.ManageWebhooks,
      P.ManageChannels,
    ],
  });
});
