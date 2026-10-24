/** Where an owner message went; the composer produces it, the bubble and route chip print it. */
export interface RouteInfo {
  /** Bots that were woken, in order. */
  botIds: string[];
  /** direct chat, @-named members, a reply to a bot message, or the group's entry bot. */
  reason: "direct" | "named" | "reply" | "entry";
}

/** Suffix after the bot names: only a reply and the entry bot say why. */
export const ROUTE_SUFFIX: Record<RouteInfo["reason"], string> = {
  direct: "",
  named: "",
  reply: " · reply",
  entry: " · entry",
};
