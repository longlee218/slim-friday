import { type AvatarTarget, type ConfigAdmin, groupAfterBotRemoval } from "@friday/core";
import { editBotHeader } from "../design/bot-file-edit";
import type { DesignContext } from "../design/design-context";
import { plainId, Refused } from "../design/design-util";
import {
  deleteBotFile,
  getBotEntry,
  guarded,
  listBotEntries,
  requireDeletableBot,
  requireOwnerBot,
  saveBotFile,
} from "./bot-admin";
import { checkMcpServer, deleteMcp, listMcp, saveMcp } from "./config-admin-mcp";
import { readOwnerFile, saveOwnerFile } from "./config-admin-owner";
import {
  deleteGroupFile,
  getGroupEntry,
  listGroupEntries,
  saveGroupFile,
  setGroupAvatar,
} from "./group-admin";

/** An avatar value that names an upload; the parser checks its shape (an id is never used as a path). */
const UPLOAD_PREFIX = "upload:";

/**
 * The settings admin over the config files: bots, groups, owner files and MCP servers. Every write runs the checks `BotDesign` uses (through
 * `ctx.checkBot` and `ctx.checkGroup`) and goes to `<config>/` only; the config watcher reloads what changed.
 */
export function createConfigAdmin(ctx: DesignContext): ConfigAdmin {
  return {
    listBots: () => listBotEntries(ctx),
    getBot: (id) => getBotEntry(ctx, id),
    saveBot: (b, mode) => saveBotFile(ctx, b, mode),
    deleteBot: (id, opts) => {
      if (opts?.cascade) leaveGroups(ctx, id);
      deleteBotFile(ctx, id, listGroupEntries(ctx));
    },
    listGroups: () => listGroupEntries(ctx),
    getGroup: (id) => getGroupEntry(ctx, id),
    saveGroup: (g, mode) => saveGroupFile(ctx, g, mode),
    deleteGroup: (id) => deleteGroupFile(ctx, id),
    setAvatar: (t, avatar) => setAvatar(ctx, t, avatar),
    presets: () => ctx.presetAvatars(),
    readOwnerFile: (f) => readOwnerFile(ctx, f),
    saveOwnerFile: (f, text) => saveOwnerFile(ctx, f, text),
    listMcp: () => listMcp(ctx),
    saveMcp: (name, s, mode) => saveMcp(ctx, name, s, mode),
    deleteMcp: (name) => deleteMcp(ctx, name),
    checkMcpServer: (name, s) => checkMcpServer(ctx, name, s),
  };
}

/**
 * Takes a bot out of every group before it is deleted: a group it was the only member of goes to
 * the trash, the others are rewritten (a removed entry bot is replaced by the next member).
 */
function leaveGroups(ctx: DesignContext, rawId: string): void {
  const id = guarded(() => requireDeletableBot(ctx, rawId));
  for (const g of listGroupEntries(ctx).filter((e) => e.members.includes(id))) {
    const next = groupAfterBotRemoval(g, id);
    if (next.kind === "delete") deleteGroupFile(ctx, g.id);
    else saveGroupFile(ctx, { ...g, members: next.members, entryBot: next.entryBot }, "update");
  }
}

/** Set or clear an avatar (a preset or `upload:<id>`) in the bot or group file; returns the value it replaced. */
function setAvatar(
  ctx: DesignContext,
  t: AvatarTarget,
  avatar: string | null,
): { previous?: string } {
  return guarded(() => {
    const id = plainId(t.id);
    if (
      avatar !== null &&
      !avatar.startsWith(UPLOAD_PREFIX) &&
      !ctx.presetAvatars().includes(avatar)
    )
      throw new Refused(`unknown avatar preset: ${avatar}`, "avatar");
    if (t.kind === "group") return setGroupAvatar(ctx, id, avatar);
    requireOwnerBot(ctx, id);
    let previous: string | undefined;
    editBotHeader(ctx, id, (h) => {
      previous = typeof h.avatar === "string" ? h.avatar : undefined;
      if (avatar === null) delete h.avatar;
      else h.avatar = avatar;
    });
    return previous === undefined ? {} : { previous };
  });
}
