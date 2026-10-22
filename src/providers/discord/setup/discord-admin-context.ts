import type { Database } from "bun:sqlite";
import type { InitDeps } from "./init-workspace";

/** What the question to the owner (before a write) carries. */
export interface ConfirmQuestion {
  /** What is confirmed, for the log. */
  kind: string;
  /** One line shown above the buttons. */
  summary: string;
  /** Long text (the diff) sent as an attachment. */
  detail?: string;
}

/**
 * What the tools of the in-process `discord-admin` server need about the run they belong to. Built per run by the
 * control-channel runner: the agent never holds a Discord token, only these tools reach Discord and the space files.
 */
export interface DiscordAdminContext {
  /** AGENT_HOME: where `workspaces/` and `backups/` live. */
  home: string;
  /** Pinned guild + ids of the creation helpers (`initWorkspace` / `initChannel`). */
  init: InitDeps;
  /** Ask the owner with buttons (the owner-confirm relay bound to this run). True only on a click on yes; fails closed. */
  confirm: (q: ConfirmQuestion) => Promise<boolean>;
  /** App db: a written MEMORY.md is re-indexed for MemorySearch at once (absent in some tests: no re-index). */
  db?: Database;
  /** Clock (tests pass a fixed one): names the backup file. */
  now?: () => Date;
}
