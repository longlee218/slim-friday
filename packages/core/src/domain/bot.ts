import type { AutonomyLevel } from "./autonomy";
import type { EffortLevel } from "./effort";

export type BotId = string;

/** A background helper a bot spawns; declared as data on the bot, not visible as a member. */
export interface SubagentSpec {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: string;
  /** Thinking effort of this helper; none = the model's default. */
  effort?: EffortLevel;
}

/** A persistent, independent member of the system. */
export interface Bot {
  id: BotId;
  name: string;
  title: string;
  /** Public one-line profile other bots see in the teammate directory (not instructions); none = title only. */
  description?: string;
  /** Bot instructions; for a bot of the config files they start with `ownerPreface` (the owner's SOUL and USER). */
  instructions: string;
  /**
   * The owner's SOUL.md and USER.md text already at the start of `instructions` (config files only). A change of it
   * is told to a running session in its next turn instead of restarting the session.
   */
  ownerPreface?: string;
  model: string;
  tools: string[];
  skills: string[];
  subagents: SubagentSpec[];
  /** Paths the bot may write to. */
  workspaces: string[];
  /** Thinking effort the bot starts at; none = the model's default. */
  effort?: EffortLevel;
  /** Highest level the bot may raise itself to with `SetEffort`; none = it cannot raise itself. */
  maxEffort?: EffortLevel;
  /** Overrides the user's autonomy level for this bot. */
  autonomy?: AutonomyLevel;
  /** Name of the bot's avatar image (the app finds the file); none = the default avatar. */
  avatar?: string;
  /** Name of the computer this bot drives (`[a-z0-9-]`); none = the bot has no computer. */
  computer?: string;
}
