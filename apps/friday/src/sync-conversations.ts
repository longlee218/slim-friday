import {
  type Bot,
  type Clock,
  type Conversation,
  type Group,
  type Log,
  postStored,
  type Surface,
} from "@friday/core";
import type { EngineStore } from "@friday/store-sqlite";

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Give every bot its fixed conversation `bot:<id>` and every group `group:<id>` (put: an existing one is kept).
 * Returns the ones that did not exist before.
 */
export async function syncConversations(
  engine: EngineStore,
  bots: Bot[],
  groups: Group[],
): Promise<Conversation[]> {
  const wanted: Conversation[] = [
    ...bots.map((b) => ({ id: `bot:${b.id}`, kind: "direct" as const, botId: b.id })),
    ...groups.map((g) => ({ id: `group:${g.id}`, kind: "group" as const, groupId: g.id })),
  ];
  const created: Conversation[] = [];
  for (const c of wanted) {
    if (!(await engine.conversations.get(c.id))) created.push(c);
    await engine.conversations.put(c);
  }
  return created;
}

/**
 * Post the hello of each new conversation as a stored message: the bot says it is ready, a group names its members.
 * A failed hello is logged; the others still go.
 */
export async function greetNew(
  deps: { engine: EngineStore; surface: Surface; clock: Clock; log: Log },
  created: Conversation[],
  bots: Bot[],
  groups: Group[],
): Promise<void> {
  const nameOf = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
  for (const c of created) {
    const text =
      c.kind === "direct"
        ? "Ready. Talk to me here."
        : `Group ready: ${(groups.find((g) => g.id === c.groupId)?.members ?? [])
            .map((m) => `@${nameOf(m)}`)
            .join(", ")}`;
    await postStored(
      { store: deps.engine, surface: deps.surface },
      {
        conversationId: c.id,
        author: c.kind === "direct" ? { kind: "bot", botId: c.botId } : { kind: "system" },
        text,
        at: deps.clock.now(),
      },
    ).catch((err) => deps.log.error({ error: why(err) }, "conversations.hello"));
  }
}

/**
 * The conversation sync of the app: `run` syncs and greets once (the start awaits it and fails with it); `sync`
 * queues a run after the previous one (config reloads) and logs a failure instead of throwing.
 */
export function conversationSync(d: {
  engine: EngineStore;
  surface: Surface;
  clock: Clock;
  log: Log;
  bots: () => Promise<Bot[]>;
  groups: () => Promise<Group[]>;
}) {
  const run = async (): Promise<void> => {
    const bots = await d.bots();
    const groups = await d.groups();
    const created = await syncConversations(d.engine, bots, groups);
    await greetNew(d, created, bots, groups);
  };
  let queue: Promise<void> = Promise.resolve();
  const sync = (): Promise<void> =>
    (queue = queue
      .then(run)
      .catch((err) => d.log.error({ error: why(err) }, "conversations.sync")));
  return { run, sync };
}
