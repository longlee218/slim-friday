import type { BotId } from "./bot";

/** One item of a bot's working memory. */
export interface ScratchpadItem {
  id: string;
  /** One list per scope key (`<botId>` or `<botId>@<groupId>`). */
  scopeKey: string;
  botId: BotId;
  /** At most 200 characters. */
  title: string;
  /** `open` and `parked` stay; `done` is deleted after 30 days. */
  status: "open" | "parked" | "done";
  /** At most 4000 characters. */
  notes: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}
