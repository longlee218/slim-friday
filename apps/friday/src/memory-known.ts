import type { BotId, GroupId, MemoryOwner, Store } from "@friday/core";

/** Longest `<known>` block given to the note extraction and the consolidation (chars). */
export const KNOWN_MAX_CHARS = 8000;

/**
 * What config already says for a memory scope, so the note calls skip it: a bot's instructions (they start with the
 * owner's SOUL and USER); a group's: the entry bot's owner preface and the group's instructions; a bot in a group:
 * its instructions and the group's. Cut at the end to `KNOWN_MAX_CHARS` (the instructions go first, the preface
 * stays). Undefined when nothing is known.
 */
export async function knownFor(
  store: Pick<Store, "bots" | "groups">,
  scope: { botId?: BotId; groupId?: GroupId },
): Promise<string | undefined> {
  const group = scope.groupId ? await store.groups.get(scope.groupId) : undefined;
  const head = scope.botId
    ? (await store.bots.get(scope.botId))?.instructions
    : group && (await store.bots.get(group.entryBot))?.ownerPreface;
  const text = [head, group?.instructions].filter(Boolean).join("\n\n");
  return text ? text.slice(0, KNOWN_MAX_CHARS) : undefined;
}

/** `knownFor` the scope of a memory owner (the daily and post-flush consolidation). */
export const ownerKnown =
  (store: Pick<Store, "bots" | "groups">) =>
  (owner: MemoryOwner): Promise<string | undefined> =>
    knownFor(store, owner.kind === "bot" ? { botId: owner.botId } : { groupId: owner.groupId });
