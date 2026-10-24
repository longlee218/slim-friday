/** Where an owner message went; the composer (Task 14) produces it, the bubble prints it. */
export interface RouteInfo {
  botId: string;
  /** direct chat, group entry bot, or a reply to a bot message. */
  kind: "direct" | "entry" | "reply";
}
