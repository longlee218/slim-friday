import type { BotId } from "../domain/bot";
import type { GroupId } from "../domain/group";
import type { HubContext } from "../hub/hub-context";
import { type StopReason, stopScope } from "./run-stop";

/** What a config reload changed, as the app resolved it. */
export interface ConfigChange {
  /** Bots that no longer exist. */
  removedBots: BotId[];
  /** Groups that no longer exist. */
  removedGroups: GroupId[];
  /** Session scope keys of bots and groups that still exist but whose definition changed. */
  resetScopes: string[];
}

/** Cancels the runs of a bot that is gone. */
const botGone: StopReason = {
  error: "The bot was removed.",
  notice: (name) => `${name} was removed: its pending requests were cancelled.`,
  always: true,
};

/** Cancels the runs of a group that is gone. */
const groupGone: StopReason = {
  error: "The group was removed.",
  notice: (name) => `The group was removed: the request to ${name} was cancelled.`,
  always: true,
};

/**
 * Apply a config reload to the stored runs (spec "Config changes"). A removed bot or group: its queued and
 * parked runs are cancelled with a notice and a running one is stopped as by Stop; its stored session ids go.
 * A changed one: its scope is marked for a fresh session, which `openRunSession` applies at the next open
 * and only while the scope has no open card (a running run keeps the config it opened with, a parked one
 * resumes its own session). Then every worker is hinted to reload the config files.
 */
export async function applyConfigChange(ctx: HubContext, c: ConfigChange): Promise<void> {
  const { store } = ctx.deps;
  for (const botId of c.removedBots) {
    await stopScope(ctx, { botId }, botGone);
    await store.sessions.clearBot(botId);
  }
  for (const groupId of c.removedGroups) {
    await stopScope(ctx, { groupId }, groupGone);
    await store.sessions.clearGroup(groupId);
  }
  for (const key of c.resetScopes) await store.scopes.markReset(key);
  ctx.hints.configChanged();
}
