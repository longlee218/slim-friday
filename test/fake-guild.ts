import type { ChannelType } from "discord.js";

/** One channel of the fake guild. */
export interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
}

/**
 * A tiny guild stand-in: `channels.fetch()` lists, `create` records + adds, `edit` records topics.
 * `failEdit` / `failCreateAt` simulate Discord failures (the Nth create call throws, 1-based).
 */
export function fakeGuild(
  initial: FakeChannel[],
  opts: { failEdit?: boolean; failCreateAt?: number } = {},
) {
  const channels = new Map(initial.map((c) => [c.id, c]));
  const created: any[] = [];
  const topics: Record<string, string> = {};
  let n = 0;
  const guild: any = {
    id: "G1",
    channels: {
      fetch: async () => new Map(channels),
      create: async (o: any) => {
        n += 1;
        if (opts.failCreateAt === n) throw new Error("discord down");
        const id = `9000000000000000${n}`;
        created.push({ ...o, id });
        channels.set(id, { id, name: o.name, type: o.type, parentId: o.parent ?? null });
        return { id };
      },
      edit: async (id: string, o: { topic?: string }) => {
        if (opts.failEdit) throw new Error("Missing Permissions");
        topics[id] = o.topic ?? "";
      },
    },
  };
  return { guild, created, topics, channels };
}
