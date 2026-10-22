import type { ActionRowBuilder, MessageActionRowComponentBuilder } from "discord.js";
import type { OwnerLanguage } from "../../../ingress/user-copy";
import type { Intent } from "../ui/components/buttons";

/** What one posted question (buttons or choice) needs: where, what to show, how to build its controls, and its hooks. */
export interface AskOptions {
  turnId: string;
  threadId: string;
  tool: string;
  prefix: "appr" | "choice";
  text: string;
  detail?: string;
  /** Attachment name of `detail`; absent = `<tool>-detail.txt`. */
  fileName?: string;
  /** Option labels in the order of their values (shown back to the owner once answered). */
  labels: string[];
  /** Intent of each option button in the same order (empty = all plain choices). */
  intents?: Intent[];
  rows: (id: string) => ActionRowBuilder<MessageActionRowComponentBuilder>[];
  language: OwnerLanguage;
  /** Runs after a successful send; a failure there never affects the question. */
  onPosted?: () => void | Promise<void>;
  /** Gets the Discord id of the posted message (a reply to it can then be routed); a failure there never affects the question. */
  onMessage?: (messageId: string) => void;
}
