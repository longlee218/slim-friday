import { ChannelType, type Guild } from "discord.js";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import {
  type CreateResult,
  createPrivate,
  findExisting,
  listGuildChannels,
  type PrivateIds,
} from "./private-channels";
import { addWorkspaceChannel, createWorkspaceDir, workspaceState } from "./workspace-template";

const log = logger.child({ module: "init-workspace" });

/** What `init:workspace` needs: the agent home, the pinned guild and who is who. */
export interface InitDeps {
  home: string;
  guild: Guild;
  ids: PrivateIds;
}

/** Next-step hint appended to a successful reply. */
const nextStep = (name: string) => `Next: add repos at workspaces/${name}/repos/<name>/repo.yaml.`;

/** Log the outcome and return the reply. */
function done(name: string, outcome: string, reply: string): string {
  logEvent(log, "admin.init_workspace", { workspace: name, outcome });
  return reply;
}

/** Refusal text for a create-only collision. */
const existsReply = (what: string) =>
  `${what} already exists in this server. Rename or delete it by hand, then run the command again. Nothing was changed.`;

/** Names being initialised right now: a second run of the same name must not race the first. */
const inFlight = new Set<string>();

/** Serialise per name, then run. */
export async function initWorkspace(deps: InitDeps, name: string): Promise<string> {
  if (inFlight.has(name))
    return done(name, "in_progress", `\`${name}\` is already in progress. Wait for it to finish.`);
  inFlight.add(name);
  try {
    return await runInit(deps, name);
  } finally {
    inFlight.delete(name);
  }
}

/**
 * `init:workspace:<name>` for a VALIDATED name. Order: refuse bad states and name clashes first (no side
 * effects), then workspace folder, private category + `#<name>-agent` (create-only), then the new channel id
 * into workspace.yaml. A rerun on a finished workspace creates nothing. Never deletes anything.
 */
async function runInit(deps: InitDeps, name: string): Promise<string> {
  const state = workspaceState(deps.home, name);
  if (state.kind === "legacy")
    return done(
      name,
      "legacy_dir",
      `workspaces/${name} is a pre-Step-B repo folder. Move it away first.`,
    );
  if (state.kind === "foreign")
    return done(
      name,
      "foreign_dir",
      `workspaces/${name} exists but is not a workspace (no valid workspace.yaml). Remove or fix it by hand.`,
    );
  if (state.kind === "workspace" && state.channels.length)
    return done(
      name,
      "already_set_up",
      `\`${name}\` is already set up (channel <#${state.channels[0]}>). Nothing created.`,
    );

  const channelName = `${name}-agent`;
  let created: CreateResult | undefined;
  let category: CreateResult | undefined;
  try {
    // Name checks come before any write so a refusal leaves no folder behind.
    const existing = await listGuildChannels(deps.guild);
    if (findExisting(existing, name, ChannelType.GuildCategory))
      return done(name, "category_exists", existsReply(`Category \`${name}\``));
    if (findExisting(existing, channelName, ChannelType.GuildText))
      return done(name, "channel_exists", existsReply(`Channel \`#${channelName}\``));

    if (state.kind === "missing") createWorkspaceDir(deps.home, name);
    category = await createPrivate(deps.guild, existing, { name, kind: "category" }, deps.ids);
    created = await createPrivate(
      deps.guild,
      existing,
      { name: channelName, kind: "text", parentId: category.id },
      deps.ids,
    );
    addWorkspaceChannel(deps.home, name, created.id);
    return done(
      name,
      "created",
      `Created private category \`${name}\` and <#${created.id}>, mapped in workspace.yaml.\n${nextStep(name)}`,
    );
  } catch (err) {
    const partial = created
      ? ` The channel <#${created.id}> exists but is not in workspace.yaml: add \`${created.id}\` to its channels by hand.`
      : category
        ? ` The category \`${name}\` was created without its channel: delete it by hand before retrying.`
        : "";
    log.error({ workspace: name, err: errText(err) }, "init workspace failed");
    return done(name, "error", `Setup failed (see logs).${partial}`);
  }
}
