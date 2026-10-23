import type { BotId } from "./bot";

export type GroupId = string;

/** A named set of bots with one entry bot that receives messages that mention nobody. */
export interface Group {
  id: GroupId;
  name: string;
  members: BotId[];
  entryBot: BotId;
}
