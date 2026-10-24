import type { BotId } from "@friday/core";

/** What the design tools of one session need from the app. */
export interface DesignContext {
  /** The bot that holds the tools (the Friday bot). */
  botId: BotId;
  /** The agent home (absolute). */
  agentHome: string;
  /** `<agent home>/config`: the only place the tools write. */
  configDir: string;
  /** The bot's own scratch dir: a skill to install must lie inside it. */
  scratchDir: string;
  /** Where bot files are read: the owner's `bots/` dir first, then the shipped one. */
  botDirs: string[];
  /** Where skills are read: the owner's `skills/` dir first, then the shipped one. */
  skillDirs: string[];
  /** Bot ids no tool may write (the shipped bots). */
  reservedBotIds: string[];
  /** Names of every tool in the catalog (SDK, effects, memory, chat...). */
  catalogTools(): string[];
  /** Names of the MCP servers a bot may name (shipped and owner). */
  mcpNames(): string[];
  /** The bots that exist now. */
  botSummaries(): { id: string; name: string; title: string }[];
  /** The groups that exist now. */
  groupSummaries(): { id: string; name: string; members: string[] }[];
  /** True when another bot (not `exceptId`) already uses this display name, any case. */
  nameTaken(name: string, exceptId: string): boolean;
  /** The app's own parsers: each throws a readable error when the file text is not valid. */
  checkBot(id: string, text: string): void;
  checkGroup(id: string, text: string): void;
  checkMcp(text: string): void;
  /** True when an env var is one the engine keeps for itself (its tokens and settings): never given to a server. */
  envDenied(name: string): boolean;
  /** The commit a cloned repo is at (git with hooks and config off), or undefined. */
  gitHead(dir: string): Promise<string | undefined>;
}
