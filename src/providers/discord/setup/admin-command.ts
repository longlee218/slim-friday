import { parseSlash } from "../../../commands/slash-commands";

/** Shown for any non-command text in a control channel. */
export const ADMIN_HELP =
  "Admin commands:\n- `/teammate create <space> <name> [model]`: a new teammate with its own private channel.\n- `/teammate list`, `/teammate edit <name> <field> <value>`, `/teammate archive <name>`.\n- `/find <keywords>`: search threads.\nOther text here is not a command and starts no run.";

/** Shown when a command comes from a place that may not run admin commands. */
export const ADMIN_ONLY_CONTROL = "Admin commands run only in #ops-control.";

/** True when the text starts like an admin command (so it never goes to the agent, wherever it is typed). */
export const isAdminText = (text: string): boolean => {
  const name = parseSlash(text)?.name;
  return name === "teammate";
};

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
