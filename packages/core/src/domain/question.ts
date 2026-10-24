import type { BotId } from "./bot";

/** One choice in a question card. */
export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

/** A question a bot puts to the owner. */
export interface QuestionCard {
  botId: BotId;
  botName: string;
  question: string;
  kind: "single" | "multi" | "confirm";
  options: QuestionOption[];
  /** The owner may type a free answer. */
  allowText: boolean;
  /** The surface closes the card after this long. */
  timeoutMs?: number;
}

/** The owner's answer: the chosen option values and/or free text. */
export interface QuestionAnswer {
  choices: string[];
  text?: string;
}
