import { expect, test } from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { liveIsPrivate } from "../src/providers/discord/setup/admin-handler";
import {
  BOT_ALLOW,
  botPermissionReport,
  findExisting,
  isPrivateChannel,
  isPrivateOverwrites,
  type Overwrite,
  OWNER_ALLOW,
  privateOverwrites,
} from "../src/providers/discord/setup/private-channels";

const ids = {
  guildId: "100000000000000001",
  ownerId: "200000000000000002",
  botId: "300000000000000003",
};
const or = (flags: bigint[]) => flags.reduce((a, b) => a | b, 0n);

test("privateOverwrites: everyone denied View, owner and bot allowed, nothing else", () => {
  const ow = privateOverwrites(ids);
  expect(ow.map((o) => o.id)).toEqual([ids.guildId, ids.ownerId, ids.botId]);
  expect(ow[0]).toEqual({
    id: ids.guildId,
    type: OverwriteType.Role,
    allow: 0n,
    deny: P.ViewChannel,
  });
  expect(ow[1]).toMatchObject({ type: OverwriteType.Member, allow: or(OWNER_ALLOW), deny: 0n });
  expect(ow[2]).toMatchObject({ type: OverwriteType.Member, allow: or(BOT_ALLOW), deny: 0n });
  // The bot additionally creates threads and embeds links.
  expect(or(BOT_ALLOW) & P.CreatePublicThreads).not.toBe(0n);
  expect(or(OWNER_ALLOW) & P.CreatePublicThreads).toBe(0n);
});

/** Variations of the builder output for the strict isPrivate table. */
const base = (): Overwrite[] => privateOverwrites(ids);
const cases: [string, (o: Overwrite[]) => Overwrite[], boolean][] = [
  ["exact builder shape", (o) => o, true],
  ["order does not matter", (o) => [...o].reverse(), true],
  [
    "extra role overwrite",
    (o) => [...o, { id: "9", type: OverwriteType.Role, allow: P.ViewChannel, deny: 0n }],
    false,
  ],
  [
    "extra deny-only overwrite",
    (o) => [...o, { id: "9", type: OverwriteType.Member, allow: 0n, deny: P.SendMessages }],
    false,
  ],
  ["no overwrites (public)", () => [], false],
  ["everyone not denied View", (o) => [{ ...o[0]!, deny: 0n }, o[1]!, o[2]!], false],
  ["everyone also allowed View", (o) => [{ ...o[0]!, allow: P.ViewChannel }, o[1]!, o[2]!], false],
  ["owner missing", (o) => [o[0]!, o[2]!], false],
  ["bot missing", (o) => [o[0]!, o[1]!], false],
  [
    "owner lacks ViewChannel",
    (o) => [o[0]!, { ...o[1]!, allow: or(OWNER_ALLOW) & ~P.ViewChannel }, o[2]!],
    false,
  ],
  [
    "bot lacks CreatePublicThreads",
    (o) => [o[0]!, o[1]!, { ...o[2]!, allow: or(BOT_ALLOW) & ~P.CreatePublicThreads }],
    false,
  ],
  [
    "bot allow set but View denied",
    (o) => [o[0]!, o[1]!, { ...o[2]!, deny: P.ViewChannel }],
    false,
  ],
  [
    "everyone as a member type",
    (o) => [{ ...o[0]!, type: OverwriteType.Member }, o[1]!, o[2]!],
    false,
  ],
  [
    "owner extra allowed bits are fine",
    (o) => [o[0]!, { ...o[1]!, allow: or(BOT_ALLOW) }, o[2]!],
    true,
  ],
];
test.each(cases)("isPrivateOverwrites: %s", (_name, mutate, expected) => {
  expect(isPrivateOverwrites(mutate(base()), ids)).toBe(expected);
});

test("isPrivateChannel reads the discord.js overwrite cache (Map of bitfield wrappers)", () => {
  const wrap = (o: Overwrite) => ({
    id: o.id,
    type: o.type,
    allow: { bitfield: o.allow },
    deny: { bitfield: o.deny },
  });
  const channel = (list: Overwrite[]) =>
    ({ permissionOverwrites: { cache: new Map(list.map((o) => [o.id, wrap(o)])) } }) as any;
  expect(isPrivateChannel(channel(base()), ids)).toBe(true);
  expect(isPrivateChannel(channel(base().slice(1)), ids)).toBe(false);
});

test("findExisting matches type and name case-insensitively", () => {
  const list = [
    { id: "1", name: "Reelme", type: ChannelType.GuildCategory },
    { id: "2", name: "reelme-agent", type: ChannelType.GuildText },
  ];
  expect(findExisting(list, "reelme", ChannelType.GuildCategory)?.id).toBe("1");
  expect(findExisting(list, "reelme", ChannelType.GuildText)).toBeUndefined();
  expect(findExisting(list, "reelme-agent", ChannelType.GuildText)?.id).toBe("2");
});

const ALL_REQUIRED = or([...BOT_ALLOW, P.ManageChannels, P.ManageRoles]);
test("botPermissionReport: Administrator satisfies all (still flagged), others name what is missing", () => {
  expect(botPermissionReport(P.Administrator)).toEqual({ missing: [], administrator: true });
  expect(botPermissionReport(ALL_REQUIRED)).toEqual({ missing: [], administrator: false });
  expect(botPermissionReport(ALL_REQUIRED & ~P.ManageRoles).missing).toEqual(["ManageRoles"]);
  expect(
    botPermissionReport(ALL_REQUIRED & ~P.EmbedLinks & ~P.CreatePublicThreads).missing,
  ).toEqual(["CreatePublicThreads", "EmbedLinks"]);
  expect(botPermissionReport(P.ManageChannels | P.ManageRoles).missing).toContain("ViewChannel");
  expect(botPermissionReport(0n).missing).toHaveLength(9);
});

/** Channel-like object as the gate sees it. */
function chan(list: Overwrite[], thread = false) {
  return {
    isThread: () => thread,
    permissionOverwrites: {
      cache: new Map(
        list.map((o) => [
          o.id,
          { id: o.id, type: o.type, allow: { bitfield: o.allow }, deny: { bitfield: o.deny } },
        ]),
      ),
    },
  } as any;
}
test("liveIsPrivate (admin gate expression): table", () => {
  const ok = privateOverwrites(ids);
  const extraRole: Overwrite = {
    id: "9",
    type: OverwriteType.Role,
    allow: P.ViewChannel,
    deny: 0n,
  };
  const extraMember: Overwrite = {
    id: "8",
    type: OverwriteType.Member,
    allow: P.ViewChannel,
    deny: 0n,
  };
  expect(liveIsPrivate(chan(ok), ids)).toBe(true);
  expect(liveIsPrivate(chan([...ok, extraRole]), ids)).toBe(false);
  expect(liveIsPrivate(chan([...ok, extraMember]), ids)).toBe(false);
  expect(liveIsPrivate(chan([ok[0]!, ok[1]!]), ids)).toBe(false); // bot missing
  expect(liveIsPrivate(chan([ok[0]!, ok[2]!]), ids)).toBe(false); // owner missing
  expect(liveIsPrivate(chan(ok, true), ids)).toBe(false); // thread of the control channel
  expect(liveIsPrivate({ isThread: () => false } as any, ids)).toBe(false); // no overwrites (DM)
});

test("invite permission integer in docs matches the flags", () => {
  const all = or([...BOT_ALLOW, P.ManageChannels, P.ManageRoles]);
  expect(all).toBe(309506198544n);
});
