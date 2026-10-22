import { ChannelType, type Message } from "discord.js";
import { languageOf, renderUserNotice, type UserNotice } from "../../../ingress/user-copy";
import { logEvent, logger } from "../../../observability/logger";
import { errText } from "../../../observability/redact";
import { adoptChannel } from "../../../workspaces/adopt-channel";
import { loadWorkspaces } from "../../../workspaces/workspace-registry";
import { liveIsPrivate } from "../setup/admin-handler";
import { setChannelTopic } from "../setup/channel-topic";
import { OPS_CATEGORY_NAME } from "../setup/discord-setup-config";
import { replyText } from "../ui/send/reply-port";
import { mayAdopt } from "./thread-placement";

const log = logger.child({ module: "channel-adoption" });

/** Facts the adoption decision reads (plain data, no discord.js types). */
export interface AdoptFacts {
  /** Real owner message with a literal `<@bot>` mention (never a slash command). */
  ownerMention: boolean;
  /** Message comes from the pinned guild (DISCORD_GUILD_ID set and equal). */
  guildOk: boolean;
  /** The channel is a guild text channel (not a thread, forum, voice, DM). */
  isText: boolean;
  /** The channel is an ops/control channel. */
  isOps: boolean;
  /** The channel id is already in some workspace.yaml. */
  mapped: boolean;
  /** Spaces whose category (name == space, holds the space's first channel) is this channel's parent. */
  spaceMatches: string[];
  /** Live privacy shape (@everyone denied, only owner and bot). */
  isPrivate: boolean;
}

/** `none` = fall through to today's behaviour; `refuse` = reply once, open no thread; `adopt` = map the channel into `space`. */
export type AdoptDecision =
  | { kind: "none" }
  | { kind: "refuse"; reason: "not-private" | "ambiguous" }
  | { kind: "adopt"; space: string };

/** Pure decision table. Cheap gates first; a refusal is only for an owner mention in a space category. */
export function channelAdoptDecision(f: AdoptFacts): AdoptDecision {
  if (!f.ownerMention || !f.guildOk || !f.isText || f.isOps || f.mapped) return { kind: "none" };
  if (f.spaceMatches.length === 0) return { kind: "none" };
  if (f.spaceMatches.length > 1) return { kind: "refuse", reason: "ambiguous" };
  if (!f.isPrivate) return { kind: "refuse", reason: "not-private" };
  return { kind: "adopt", space: f.spaceMatches[0] as string };
}

/** What the handler needs from the adopter. `refused`: the owner already got the reason, stop. */
export type ChannelAdopter = (
  msg: Message,
  /** The handler's receipt: called after the owner's reply so the busy-ack reaction is cleared. */
  visible?: () => Promise<void>,
) => Promise<"none" | "adopted" | "refused">;

/** Inputs of the adopter. */
export interface ChannelAdopterDeps {
  /** AGENT_HOME. */
  home: string;
  ownerId: string;
  /** DISCORD_GUILD_ID (undefined: no pin, never adopts). */
  guildId?: string;
  botId: () => string | undefined;
  /** Ops and control channel ids (never adopted). */
  ops: ReadonlySet<string>;
}

/**
 * Spaces owning the category `parentId`: the space's first channel sits in it and the category is named like the space
 * (same rule as `/init-channel`, no category id is stored). Reads the guild cache only; a miss means no match (fail closed).
 */
function spacesOfCategory(msg: Message, home: string, parentId: string): string[] {
  const cache = msg.guild?.channels.cache;
  if (!cache) return [];
  return loadWorkspaces(home)
    .workspaces.filter((w) => {
      const first = w.channels[0] ? cache.get(w.channels[0]) : undefined;
      const category = cache.get(parentId);
      return (
        w.name !== OPS_CATEGORY_NAME &&
        first?.parentId === parentId &&
        category?.type === ChannelType.GuildCategory &&
        category.name.toLowerCase() === w.name // space names are lowercase ASCII, exact match like /init-channel
      );
    })
    .map((w) => w.name);
}

/** Reply once to the owner message in its channel; a send failure is logged, never thrown. */
async function notify(msg: Message, notice: UserNotice): Promise<void> {
  try {
    await replyText(msg, renderUserNotice(notice, languageOf(msg.content)));
  } catch (err) {
    log.warn({ err: errText(err) }, "channel adoption notice failed");
  }
}

/**
 * Build the adopter: the first owner @mention in an unmapped private text channel under a space category maps the channel
 * (`{id, slugged name, mode: task}`, all space locations), creates its memory dir and sets its topic. Cheap checks (owner,
 * literal mention, pinned guild, channel type, ops) run before any workspace read. Never throws.
 */
export function createChannelAdopter(deps: ChannelAdopterDeps): ChannelAdopter {
  return async (msg, visible) => {
    try {
      const botId = deps.botId();
      const ch = msg.channel;
      const ownerMention = !!botId && mayAdopt(msg, deps.ownerId, botId);
      const guildOk = !!deps.guildId && msg.guildId === deps.guildId;
      const isText = ch.type === ChannelType.GuildText && !ch.isThread();
      if (!botId || !ownerMention || !guildOk || !isText || deps.ops.has(ch.id)) return "none";
      const parentId = "parentId" in ch ? ch.parentId : null;
      const scan = loadWorkspaces(deps.home);
      const facts: AdoptFacts = {
        ownerMention,
        guildOk,
        isText,
        isOps: deps.ops.has(ch.id),
        mapped: scan.workspaces.some((w) => w.channels.includes(ch.id)),
        spaceMatches: parentId ? spacesOfCategory(msg, deps.home, parentId) : [],
        isPrivate: liveIsPrivate(ch, {
          guildId: msg.guildId as string,
          ownerId: deps.ownerId,
          botId,
        }),
      };
      const decision = channelAdoptDecision(facts);
      if (decision.kind === "none") return "none";
      if (decision.kind === "refuse") {
        logEvent(
          log,
          "channel.adopt_refused",
          { channelId: ch.id, reason: decision.reason },
          "warn",
        );
        await notify(msg, { kind: "channel-adopt-refused", reason: decision.reason });
        await visible?.();
        return "refused";
      }
      const name = "name" in ch ? String(ch.name) : "";
      const done = adoptChannel(deps.home, decision.space, ch.id, name);
      if (!done.ok && done.reason === "already_mapped") return "none"; // lost a race to the same channel: it is mapped now
      if (!done.ok) {
        logEvent(
          log,
          "channel.adopt_refused",
          { channelId: ch.id, space: decision.space, reason: done.reason },
          "warn",
        );
        const reason = done.reason === "no_free_name" ? "name-taken" : "failed";
        await notify(msg, { kind: "channel-adopt-refused", reason });
        await visible?.();
        return "refused";
      }
      if (msg.guild) await setChannelTopic(msg.guild, ch.id, "task"); // best effort, warns on failure
      logEvent(log, "channel.adopted", {
        channelId: ch.id,
        space: decision.space,
        name: done.name,
      });
      await notify(msg, { kind: "channel-adopted", space: decision.space, name: done.name });
      await visible?.();
      return "adopted";
    } catch (err) {
      log.error({ err: errText(err) }, "channel adoption failed"); // fall through to today's refusal
      return "none";
    }
  };
}
