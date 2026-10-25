import type { BotId } from "./bot";

/** How much a bot may do without asking. */
export type AutonomyLevel = "careful" | "balanced" | "autonomous";

/** What a tool call is, judged from its annotations. */
export type RiskClass = "read" | "local" | "write" | "external" | "destructive" | "unknown";

/** The result of the permission decision. */
export type Outcome = "allow" | "ask" | "ask_always" | "deny";

/** The user's autonomy settings. */
export interface PermissionSettings {
  level: AutonomyLevel;
  /** Per-bot level overrides. */
  botLevels?: Record<BotId, AutonomyLevel>;
  /** Per-tool outcome overrides. */
  tools?: Record<string, Outcome>;
  /** Auto Review (spec §6.14): a model may clear a plain level ask; unset or false: off (the default). */
  autoReview?: boolean;
}
