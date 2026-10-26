/** What happens to a group when one of its bots is deleted. */
export type GroupAfterRemoval =
  | { kind: "delete" }
  | { kind: "update"; members: string[]; entryBot: string };

/**
 * The web copy of core's `groupAfterBotRemoval` (the web app may not import core), used only to
 * show the outcome in the confirm; the engine applies its own. Both are pinned by one test table.
 */
export function groupAfterBotRemoval(
  g: { members: string[]; entryBot: string },
  botId: string,
): GroupAfterRemoval {
  const members = g.members.filter((m) => m !== botId);
  if (members.length === 0) return { kind: "delete" };
  if (g.entryBot !== botId) return { kind: "update", members, entryBot: g.entryBot };
  const i = g.members.indexOf(botId);
  return { kind: "update", members, entryBot: g.members[(i + 1) % g.members.length] as string };
}
