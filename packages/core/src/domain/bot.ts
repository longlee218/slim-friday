import type { AutonomyLevel } from "./autonomy";

export type BotId = string;

/** A background helper a bot spawns; declared as data on the bot, not visible as a member. */
export interface SubagentSpec {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: string;
}

/** A persistent, independent member of the system. */
export interface Bot {
  id: BotId;
  name: string;
  title: string;
  instructions: string;
  model: string;
  tools: string[];
  skills: string[];
  subagents: SubagentSpec[];
  /** Paths the bot may write to. */
  workspaces: string[];
  /** Overrides the user's autonomy level for this bot. */
  autonomy?: AutonomyLevel;
  /** Name of the bot's avatar image (the app finds the file); none = the default avatar. */
  avatar?: string;
}
