import { ChannelType } from "discord.js";
import { ensureChannelDir } from "../memory/persona";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { loadWorkspaces } from "../workspaces/workspace-registry";
import { setChannelTopic } from "./channel-topic";
import { OPS_CATEGORY_NAME } from "./discord-setup-config";
import type { InitDeps } from "./init-workspace";
import { createPrivate, findExisting, listGuildChannels } from "./private-channels";
import { addWorkspaceChannel, workspaceState } from "./workspace-template";

const log = logger.child({ module: "init-channel" });

/** Log the outcome and return the reply. */
function done(path: string, outcome: string, reply: string): string {
  logEvent(log, "admin.init_channel", { path, outcome });
  return reply;
}

/** Spaces+channels being initialised right now: a second run of the same path must not race the first. */
const inFlight = new Set<string>();

/** Serialise per `space/name`, then run. */
export async function initChannel(deps: InitDeps, space: string, name: string): Promise<string> {
  const path = `${space}/${name}`;
  if (inFlight.has(path))
    return done(path, "in_progress", `\`${path}\` is already in progress. Wait for it to finish.`);
  inFlight.add(path);
  try {
    return await runInit(deps, space, name);
  } finally {
    inFlight.delete(path);
  }
}

/**
 * `init:channel:<space>/<name>` for VALIDATED names. Refuse-first (no side effects): space must be set up,
 * the name must be new in the space yaml and in the space category. Then create the private channel under
 * the category, append it to workspace.yaml, create its memory dir and set the topic. Never edits or deletes.
 * The category id is not stored: it is the parent of the space's first mapped channel.
 */
async function runInit(deps: InitDeps, space: string, name: string): Promise<string> {
  const path = `${space}/${name}`;
  const state = workspaceState(deps.home, space);
  if (state.kind !== "workspace" || !state.channels.length)
    return done(
      path,
      "space_not_set_up",
      `Space \`${space}\` is missing or not set up. Run \`/init-workspace ${space}\` first.`,
    );
  let created: string | undefined;
  try {
    // One source of truth for names: the registry.
    const ws = loadWorkspaces(deps.home).workspaces.find((w) => w.name === space);
    if (ws?.channelDefs.some((c) => c.name === name))
      return done(
        path,
        "yaml_exists",
        `\`${name}\` is already a channel of \`${space}\`. Nothing changed.`,
      );
    const existing = await listGuildChannels(deps.guild);
    const first = existing.find((c) => c.id === state.channels[0]);
    if (!first?.parentId)
      return done(
        path,
        "no_category",
        `Cannot find the category of \`${space}\` (its first channel is gone or has no category). Nothing changed.`,
      );
    // The derived category must be the space's own category (name == space), never an ops or foreign one.
    const parent = existing.find((c) => c.id === first.parentId);
    if (
      space === OPS_CATEGORY_NAME ||
      parent?.type !== ChannelType.GuildCategory ||
      parent.name.toLowerCase() !== space.toLowerCase()
    )
      return done(
        path,
        "bad_category",
        `The first channel of \`${space}\` is not in a category named \`${space}\`. Move it back by hand. Nothing changed.`,
      );
    if (findExisting(existing, name, ChannelType.GuildText, first.parentId))
      return done(
        path,
        "channel_exists",
        `Channel \`#${name}\` already exists in category \`${space}\`. Rename or delete it by hand. Nothing changed.`,
      );
    const made = await createPrivate(
      deps.guild,
      existing,
      { name, kind: "text", parentId: first.parentId },
      deps.ids,
    );
    // Create-only: a pre-existing channel is never adopted (no yaml entry, no topic edit).
    if (made.status !== "created")
      return done(path, "channel_exists", `Channel \`#${name}\` already exists. Nothing changed.`);
    created = made.id;
    addWorkspaceChannel(deps.home, space, { id: made.id, name, mode: "task" });
    ensureChannelDir(deps.home, space, name);
    await setChannelTopic(deps.guild, made.id, "task");
    return done(
      path,
      "created",
      `Created private <#${made.id}> in category \`${space}\`, mapped in workspace.yaml (mode: task).`,
    );
  } catch (err) {
    log.error({ path, err: errText(err) }, "init channel failed");
    const partial = created
      ? ` The channel <#${created}> exists; check workspaces/${space}/workspace.yaml (add \`{id: "${created}", name: ${name}, mode: task}\` under channels if missing) and channels/${name}/MEMORY.md.`
      : "";
    return done(path, "error", `Setup failed (see logs).${partial}`);
  }
}
