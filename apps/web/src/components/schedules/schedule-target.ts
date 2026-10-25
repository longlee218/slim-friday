import type { Directory } from "../../api/directory";

/** The name of a `bot:<id>` or `group:<id>` chat; the id stands in for a gone bot or group. */
export function conversationName(conversationId: string, dir: Directory): string {
  const [kind, id = ""] = conversationId.split(":");
  const name = kind === "group" ? dir.groups.get(id)?.name : dir.bots.get(id)?.name;
  return name ?? id;
}

/** Where a schedule of `botId` may post: the bot's own chat, then each group it belongs to. */
export function postTargets(botId: string, dir: Directory): { id: string; name: string }[] {
  const groups = [...dir.groups.values()].filter((g) => g.members.includes(botId));
  return [
    { id: `bot:${botId}`, name: dir.botName(botId) },
    ...groups.map((g) => ({ id: `group:${g.id}`, name: g.name })),
  ];
}
