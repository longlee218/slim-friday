import { parseSlash } from "../commands/slash-commands";
import {
  CHANNEL_NAME,
  isWorkspaceName,
  reservedWorkspaces,
  WORKSPACE_NAME,
} from "../config/workspace-paths";
import { OPS_CHANNEL_NAMES } from "./discord-setup-config";

/** Channel names the owner cannot create in a space: they are the ops channel names. */
const reservedChannels = (): string[] => Object.values(OPS_CHANNEL_NAMES);

/** Parsed admin text typed by the owner. */
export type AdminCommand =
  | { kind: "init_workspace"; name: string }
  | { kind: "init_channel"; space: string; name: string }
  | { kind: "invalid_name"; reply: string }
  | { kind: "help"; reply: string };

/** Shown for any non-command text in a control channel. */
const ADMIN_HELP =
  "Admin commands:\n- `/init-workspace <name>`: create the workspace folder, a private category `<name>` and a channel `#<name>`.\n- `/init-channel <space>/<name>`: add a private channel `#<name>` to the space's category.\n- Memory notes: ask in a workspace channel; the root MEMORY.md is edited by hand.\nAny other text here goes to the server manager: ask it to create a space or channel, apply a space kind template or edit a space's persona files. It shows a diff and asks before it writes. Send `/stop` to abort its run.";

/** Shown when a command comes from a place that may not run admin commands. */
export const ADMIN_ONLY_CONTROL = "Admin commands run only in #ops-control.";

/** True when the text starts like an admin command (so it never goes to the agent, wherever it is typed). */
export const isAdminText = (text: string): boolean => {
  const name = parseSlash(text)?.name;
  return name === "init-workspace" || name === "init-channel";
};

/**
 * Parse admin text (already stripped of the bot mention). The name is validated here, before any
 * filesystem or Discord call: lowercase letters, digits, hyphens; max 32 chars; not reserved.
 */
export function parseAdminCommand(text: string): AdminCommand {
  const slash = parseSlash(text);
  if (slash?.name === "init-channel") return parseInitChannel(slash.arg);
  if (slash?.name !== "init-workspace") return { kind: "help", reply: ADMIN_HELP };
  const name = slash.arg;
  if (isWorkspaceName(name)) return { kind: "init_workspace", name };
  const reserved = WORKSPACE_NAME.test(name) && reservedWorkspaces().includes(name);
  return {
    kind: "invalid_name",
    reply: reserved
      ? `\`${name}\` is reserved. Pick another workspace name.`
      : "Workspace name: lowercase letters, digits and hyphens only, 1-32 chars, starting with a letter or digit (no spaces, slashes, dots).",
  };
}

/** Parse the `<space>/<name>` of `/init-channel`: both names validated before any filesystem or Discord call. */
function parseInitChannel(path: string): AdminCommand {
  const [space = "", name = "", ...rest] = path.split("/");
  const invalid = (reply: string): AdminCommand => ({ kind: "invalid_name", reply });
  if (rest.length || !WORKSPACE_NAME.test(space))
    return invalid("Use `/init-channel <space>/<name>` with an existing space name.");
  if (!CHANNEL_NAME.test(name))
    return invalid("Channel name: lowercase letters, digits and hyphens only, 1-64 chars.");
  if (reservedChannels().includes(name))
    return invalid(`\`${name}\` is reserved. Pick another channel name.`);
  return { kind: "init_channel", space, name };
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
