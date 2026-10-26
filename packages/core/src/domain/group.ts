import type { BotId } from "./bot";

export type GroupId = string;

/** A named set of bots with one entry bot that receives messages that mention nobody. */
export interface Group {
  id: GroupId;
  name: string;
  members: BotId[];
  entryBot: BotId;
  /** Absolute project dirs the group's bots work in (empty: none). */
  workspaces: string[];
  /** Text about the group's project, given to every member (empty: none). */
  instructions: string;
  /** A preset name or `upload:<id>`; unset = the default avatar. */
  avatar?: string;
}

/** What happens to a group when one of its bots is deleted. */
export type GroupAfterRemoval =
  | { kind: "delete" }
  | { kind: "update"; members: BotId[]; entryBot: BotId };

/**
 * A group without `botId`: deleted when it was the only member; otherwise the member list without
 * it, and a removed entry bot is replaced by the member right after it (wrapping to the first), so
 * the confirm shown to the owner names the real successor.
 */
export function groupAfterBotRemoval(
  g: Pick<Group, "members" | "entryBot">,
  botId: BotId,
): GroupAfterRemoval {
  const members = g.members.filter((m) => m !== botId);
  if (members.length === 0) return { kind: "delete" };
  if (g.entryBot !== botId) return { kind: "update", members, entryBot: g.entryBot };
  const i = g.members.indexOf(botId);
  return { kind: "update", members, entryBot: g.members[(i + 1) % g.members.length] as BotId };
}
