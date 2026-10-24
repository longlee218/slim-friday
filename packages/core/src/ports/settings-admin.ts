import type { AutonomyLevel } from "../domain/autonomy";
import type { BotId } from "../domain/bot";
import type { EffortLevel } from "../domain/effort";
import type { MemoryOwner } from "./memory";

/** Most rules per bot or group (same value as the contract's `MAX_RULES`). */
export const RULES_MAX = 50;
/** Most characters in one rule (contract: `MAX_RULE_CHARS`). */
export const RULE_MAX_CHARS = 500;
/** Most characters in USER.md or SOUL.md (contract: `MAX_OWNER_FILE_CHARS`). */
export const OWNER_FILE_MAX_CHARS = 20_000;
/** Most bytes of an avatar upload (contract: `MAX_AVATAR_BYTES`). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Longest side of an avatar in pixels (the browser crops and scales before upload). */
export const AVATAR_MAX_PX = 512;

/** A refused admin call; the API maps `code` to its error code and `field` to `data.field`. */
export class AdminError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PAYLOAD_TOO_LARGE",
    message: string,
    /** The form field the message is about, when there is one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

/** What the owner edits of a bot (subagents are not editable here). */
export interface BotInput {
  id: string;
  name: string;
  title: string;
  model: string;
  instructions: string;
  tools: string[];
  skills: string[];
  workspaces: string[];
  effort?: EffortLevel;
  maxEffort?: EffortLevel;
  autonomy?: AutonomyLevel;
}

/** A bot as listed: its input plus its avatar value and whether it ships with the app. */
export interface BotEntry extends BotInput {
  avatar?: string;
  shipped: boolean;
}

/** What the owner edits of a group. */
export interface GroupInput {
  id: string;
  name: string;
  members: string[];
  entryBot: string;
  workspaces: string[];
  instructions: string;
}

/** A group as listed. */
export interface GroupEntry extends GroupInput {
  avatar?: string;
}

/** An MCP server definition: a local command or a remote URL. */
export type McpServerInput =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** An MCP server as listed, with the bots that name it. */
export interface McpEntry {
  name: string;
  server: McpServerInput;
  shipped: boolean;
  usedBy: BotId[];
}

/** The outcome of a connection test of an MCP server. */
export type McpProbeResult =
  | { status: "connected"; tools: string[] }
  | { status: "needs-auth" }
  | { status: "failed"; error: string };

/** Connects to a server once and reports what it found. */
export type McpProbe = (name: string, server: McpServerInput) => Promise<McpProbeResult>;

/** An installed or shipped skill. */
export interface SkillEntry {
  name: string;
  description: string;
  shipped: boolean;
  /** Where it was installed from (installed skills only). */
  source?: string;
  path?: string;
  sha?: string;
  installedAt?: string;
  files: string[];
  body: string;
  usedBy: BotId[];
}

/** What a skill lookup found; nothing is installed until the owner confirms it. */
export interface SkillLookup {
  lookupId: string;
  source: string;
  path?: string;
  sha: string;
  /** Epoch ms after which `lookupId` is no longer valid. */
  expiresAt: number;
  skills: { name: string; description: string; files: string[]; scripts: string[] }[];
}

/** The two owner files shared by every bot. */
export type OwnerFile = "USER" | "SOUL";

/** The bot or group an avatar belongs to. */
export type AvatarTarget = { kind: "bot" | "group"; id: string };

/** Admin over the config files (`<AGENT_HOME>/config/`); every write runs the same parsers `BotDesign` uses. */
export interface ConfigAdmin {
  listBots(): BotEntry[];
  getBot(id: string): BotEntry;
  /** `create` refuses an existing id (CONFLICT), `update` refuses a missing one (NOT_FOUND). */
  saveBot(b: BotInput, mode: "create" | "update"): void;
  deleteBot(id: string): void;
  listGroups(): GroupEntry[];
  getGroup(id: string): GroupEntry;
  saveGroup(g: GroupInput, mode: "create" | "update"): void;
  deleteGroup(id: string): void;
  /** Sets the avatar value (a preset name or `upload:<id>`; null clears it); returns the value it replaced. */
  setAvatar(t: AvatarTarget, avatar: string | null): { previous?: string };
  /** Names of the shipped avatar presets. */
  presets(): string[];
  readOwnerFile(f: OwnerFile): string;
  saveOwnerFile(f: OwnerFile, text: string): void;
  listMcp(): McpEntry[];
  saveMcp(name: string, s: McpServerInput, mode: "create" | "update"): void;
  deleteMcp(name: string): void;
  /** Runs the MCP parser on a definition without saving it; throws `AdminError` when refused. */
  checkMcpServer(name: string, s: McpServerInput): void;
}

/** Admin over skills: a lookup first, an install only after the owner confirms it. */
export interface SkillAdmin {
  list(): SkillEntry[];
  lookup(source: string, path?: string): Promise<SkillLookup>;
  install(lookupId: string, name: string): SkillEntry;
  checkUpdate(name: string): Promise<{ sha?: string; latestSha: string; updateAvailable: boolean }>;
  update(lookupId: string, name: string): SkillEntry;
  /** Removes the skill and returns the bots whose file named it (the name is taken out of each). */
  remove(name: string): { botIds: BotId[] };
  setUsedBy(name: string, botIds: BotId[]): SkillEntry;
}

/** One memory note with a stable id. */
export interface MemoryNote {
  id: string;
  kind: "decision" | "fact" | "preference" | "lesson";
  text: string;
  day?: string;
}

/** The journal items of one day. */
export interface JournalDay {
  day: string;
  items: string[];
}

/** One owner rule of a bot or group; off rules stay in the file but not in the prompt. */
export interface Rule {
  text: string;
  on: boolean;
}

/** Admin over a bot's or group's memory files (inside `<AGENT_HOME>/memory/`). */
export interface MemoryAdmin {
  list(o: MemoryOwner): Promise<{ notes: MemoryNote[]; promptChars: number; capChars: number }>;
  save(o: MemoryOwner, kind: MemoryNote["kind"], text: string): Promise<void>;
  edit(o: MemoryOwner, id: string, text: string): Promise<void>;
  delete(o: MemoryOwner, id: string): Promise<void>;
  journal(o: MemoryOwner, day?: string): JournalDay[];
  rules(o: MemoryOwner): Rule[];
  saveRules(o: MemoryOwner, rules: Rule[]): void;
}
