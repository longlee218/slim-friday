import type { FileConfig } from "@friday/config";
import type { BotHub, Conversation, Log, Store } from "@friday/core";

/** Why a failure happened, as text. */
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a config reload acts on. */
export interface ConfigReloadDeps {
  config: FileConfig;
  hub: BotHub;
  /** The composed store: the bots and groups as the reloaded config now has them. */
  store: Pick<Store, "bots" | "groups">;
  /** Gives new bots and groups their conversations (queued, one at a time); resolves with the ones it created. */
  sync: () => Promise<Conversation[]>;
  /** Called once the reload has synced (the web surface publishes `config.changed`). */
  onConfigChanged?: () => void;
  log: Log;
}

/**
 * Watch the config dir. On a change the stored runs follow it (`hub.configChanged`): a removed bot or group has
 * its queued and parked runs cancelled and its running ones stopped; a changed one gets a fresh session at its
 * next open (a running run keeps its config, a parked one resumes on its own session). Then the conversations
 * are synced, each new bot gets its intro run, and the change reported. Returns the stop function.
 */
export function watchConfigReload(d: ConfigReloadDeps): () => void {
  return d.config.watch((r) => {
    for (const p of r.problems) d.log.warn(p, "config.problem");
    void (async () => {
      const removedBots: string[] = [];
      const removedGroups: string[] = [];
      const resetScopes: string[] = [];
      // A changed bot: its direct scope and its scope in every group it is a member of.
      for (const id of r.changedBots) {
        if (!(await d.store.bots.get(id))) removedBots.push(id);
        else resetScopes.push(id, ...d.config.groupIdsOf(id).map((g) => `${id}@${g}`));
      }
      // A changed group: the group scope of each member.
      for (const id of r.changedGroups) {
        const group = await d.store.groups.get(id);
        if (!group) removedGroups.push(id);
        else resetScopes.push(...group.members.map((m) => `${m}@${id}`));
      }
      await d.hub.configChanged({ removedBots, removedGroups, resetScopes });
      const created = await d.sync();
      // A bot that got its direct conversation at a reload is new (the first sync at start creates the conversations
      // of the bots that already exist): it introduces itself. One run per bot (deduped), so a repeat adds none.
      for (const c of created) if (c.kind === "direct") await d.hub.queueIntroRun(c.botId);
      d.onConfigChanged?.();
    })().catch((err) => d.log.error({ error: why(err) }, "config.reload"));
  });
}
