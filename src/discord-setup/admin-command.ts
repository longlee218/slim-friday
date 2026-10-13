import { slashToLegacy } from "../commands/slash-commands";
import { isWorkspaceName, reservedWorkspaces, WORKSPACE_NAME } from "../config/workspace-paths";

/** Prefix of the one admin command. */
const INIT_PREFIX = /^init:workspace:/i;

/** Parsed admin text typed by the owner. */
export type AdminCommand =
  | { kind: "init_workspace"; name: string }
  | { kind: "invalid_name"; reply: string }
  | { kind: "help"; reply: string };

/** Shown for any non-command text in a control channel. */
export const ADMIN_HELP =
  "Admin commands:\n- `/init-workspace <name>` (legacy: `init:workspace:<name>`): create the workspace folder, a private category `<name>` and `#<name>-agent`.\n- Memory notes: ask in a workspace channel; the root MEMORY.md is edited by hand.";

/** Shown when a command comes from a place that may not run admin commands. */
export const ADMIN_ONLY_CONTROL = "Admin commands run only in #ops-control.";

/** True when the text starts like an admin command (so it never goes to the agent, wherever it is typed). */
export const isAdminText = (text: string): boolean => INIT_PREFIX.test(slashToLegacy(text).trim());

/**
 * Parse admin text (already stripped of the bot mention). The name is validated here, before any
 * filesystem or Discord call: lowercase letters, digits, hyphens; max 32 chars; not reserved.
 */
export function parseAdminCommand(text: string): AdminCommand {
  const t = slashToLegacy(text).trim();
  if (!INIT_PREFIX.test(t)) return { kind: "help", reply: ADMIN_HELP };
  const name = t.replace(INIT_PREFIX, "");
  if (isWorkspaceName(name)) return { kind: "init_workspace", name };
  const reserved = WORKSPACE_NAME.test(name) && reservedWorkspaces().includes(name);
  return {
    kind: "invalid_name",
    reply: reserved
      ? `\`${name}\` is reserved. Pick another workspace name.`
      : "Workspace name: lowercase letters, digits and hyphens only, 1-32 chars, starting with a letter or digit (no spaces, slashes, dots).",
  };
}

/** Facts the admin gate decides on (all derived by the caller from the Discord message). */
export interface GateFacts {
  /** DISCORD_GUILD_ID is configured. */
  guildPinned: boolean;
  /** The message comes from the pinned guild. */
  inPinnedGuild: boolean;
  /** The message is inside a thread. */
  isThread: boolean;
  channelId: string;
  /** Ids from discord.yaml `controlChannels`. */
  controlChannels: string[];
  /** Live privacy check of the channel (strict shape). */
  privateNow: boolean;
}

/** Gate result: run, or refuse with the reply to post. */
export type GateResult = { ok: true } | { ok: false; reply: string };

/**
 * The admin gate, after the owner check: pinned guild -> control channel id (not a thread) AND live
 * privacy. Anything else is refused without running or reaching the agent.
 */
export function adminGate(f: GateFacts): GateResult {
  if (!f.guildPinned || !f.inPinnedGuild)
    return { ok: false, reply: "Admin commands need DISCORD_GUILD_ID set and this server pinned." };
  if (f.isThread || !f.controlChannels.includes(f.channelId))
    return { ok: false, reply: ADMIN_ONLY_CONTROL };
  if (!f.privateNow)
    return { ok: false, reply: "This control channel is not private (extra access). Refusing." };
  return { ok: true };
}
