import { ChannelType, type Guild } from "discord.js";
import { CHANNEL_NAME, isWorkspaceName } from "../../../config/workspace-paths";
import { ensureChannelDir } from "../../../memory/persona";
import { logEvent, logger } from "../../../observability/logger";
import { errText } from "../../../observability/redact";
import { TeammateAdminError } from "../../../teammates/teammate-admin";
import { loadWorkspaces } from "../../../workspaces/workspace-registry";
import { setChannelTopic } from "./channel-topic";
import { OPS_CATEGORY_NAME, OPS_CHANNEL_NAMES } from "./discord-setup-config";
import {
  createPrivate,
  findExisting,
  listGuildChannels,
  type PrivateIds,
} from "./private-channels";
import { addWorkspaceChannel, createWorkspaceDir, workspaceState } from "./workspace-template";

/** What creating a teammate channel needs: the agent home, the pinned guild and who is who. */
export interface InitDeps {
  home: string;
  guild: Guild;
  ids: PrivateIds;
}

const log = logger.child({ module: "teammate-channel" });

/** Names being created right now (`space/name`): a second run of the same path must not race the first. */
const inFlight = new Set<string>();

/**
 * The private channel of a new teammate: `#<name>` in the private category `<space>`, mapped in that space's
 * `workspace.yaml` (mode task) with its memory folder and topic. A space that does not exist yet is created first
 * (folder, category). Create-only: a channel or category that already exists is never adopted. Every check runs before the
 * first Discord or file write. A failure after the channel exists names it in the error (nothing is deleted).
 */
export async function createTeammateChannel(
  deps: InitDeps,
  spec: { space: string; name: string },
): Promise<{ channelId: string }> {
  const { space, name } = spec;
  const path = `${space}/${name}`;
  if (!isWorkspaceName(space) || space === OPS_CATEGORY_NAME)
    throw new TeammateAdminError(
      "Space name: lowercase letters, digits and hyphens, 1-32 chars; not a reserved name.",
    );
  if (!CHANNEL_NAME.test(name) || (Object.values(OPS_CHANNEL_NAMES) as string[]).includes(name))
    throw new TeammateAdminError(
      "Channel name: lowercase letters, digits and hyphens; not reserved.",
    );
  if (inFlight.has(path)) throw new TeammateAdminError(`\`${path}\` is already in progress.`);
  inFlight.add(path);
  let made: string | undefined;
  try {
    const state = workspaceState(deps.home, space);
    if (state.kind === "foreign")
      throw new TeammateAdminError(
        `workspaces/${space} exists but is not a space. Fix it by hand.`,
      );
    if (
      loadWorkspaces(deps.home)
        .workspaces.find((w) => w.name === space)
        ?.channelDefs.some((c) => c.name === name)
    )
      throw new TeammateAdminError(`\`${name}\` is already a channel of \`${space}\`.`);
    const existing = await listGuildChannels(deps.guild);
    // Category: the parent of the space's first channel, or a new one for a new space.
    let parentId: string | undefined;
    if (state.kind === "workspace" && state.channels.length) {
      const first = existing.find((c) => c.id === state.channels[0]);
      const parent = existing.find((c) => c.id === first?.parentId);
      if (
        parent?.type !== ChannelType.GuildCategory ||
        parent.name.toLowerCase() !== space.toLowerCase()
      )
        throw new TeammateAdminError(`Cannot find the category \`${space}\` of this space.`);
      parentId = parent.id;
    } else if (findExisting(existing, space, ChannelType.GuildCategory)) {
      throw new TeammateAdminError(`Category \`${space}\` already exists. Rename it by hand.`);
    }
    if (findExisting(existing, name, ChannelType.GuildText, parentId))
      throw new TeammateAdminError(`Channel \`#${name}\` already exists. Rename it by hand.`);

    if (state.kind === "missing") createWorkspaceDir(deps.home, space);
    parentId ??= (
      await createPrivate(deps.guild, existing, { name: space, kind: "category" }, deps.ids)
    ).id;
    const channel = await createPrivate(
      deps.guild,
      existing,
      { name, kind: "text", parentId },
      deps.ids,
    );
    made = channel.id;
    addWorkspaceChannel(deps.home, space, { id: channel.id, name, mode: "task" });
    ensureChannelDir(deps.home, space, name);
    await setChannelTopic(deps.guild, channel.id, "task");
    logEvent(log, "teammate.channel_created", { path });
    return { channelId: channel.id };
  } catch (err) {
    if (err instanceof TeammateAdminError) throw err;
    log.error({ path, err: errText(err) }, "teammate channel failed");
    throw new TeammateAdminError(
      `Setup failed (see logs).${made ? ` The channel <#${made}> exists; check workspaces/${space}/workspace.yaml.` : ""}`,
    );
  } finally {
    inFlight.delete(path);
  }
}
