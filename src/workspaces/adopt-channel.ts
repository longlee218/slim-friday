import { existsSync, rmSync } from "node:fs";
import { CHANNEL_NAME, workspacePaths } from "../config/workspace-paths";
import { OPS_CATEGORY_NAME, OPS_CHANNEL_NAMES } from "../discord-setup/discord-setup-config";
import { ensureChannelDir } from "../memory/persona";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { loadWorkspaces } from "./workspace-registry";
import { channelEntries, updateWorkspaceYaml } from "./workspace-yaml-write";

/** Names an adopted channel may never take: the ops category and the ops channels. */
const RESERVED = new Set<string>([OPS_CATEGORY_NAME, ...Object.values(OPS_CHANNEL_NAMES)]);

/** Highest numeric suffix tried on a name collision (`shop`, `shop-2` ... `shop-9`). */
const MAX_SUFFIX = 9;

/** Outcome of `adoptChannel`: the yaml name now in use, or why nothing was written. */
export type AdoptResult =
  | { ok: true; name: string }
  | { ok: false; reason: "already_mapped" | "no_free_name" | "failed" };

/** Discord channel name -> dir-safe slug: lowercase, `[^a-z0-9-]` -> `-`, edge dashes trimmed, cut to 64. Empty when nothing is left. */
export function slugChannelName(discordName: string): string {
  const slug = discordName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return CHANNEL_NAME.test(slug) ? slug : "";
}

/** `base`, else `base-2` .. `base-9` (base is cut so the suffix keeps the name <= 64); undefined when all are taken or reserved. */
export function uniqueChannelName(taken: ReadonlySet<string>, base: string): string | undefined {
  const free = (n: string) => !taken.has(n) && !RESERVED.has(n);
  if (free(base)) return base;
  for (let i = 2; i <= MAX_SUFFIX; i += 1) {
    const name = `${base.slice(0, 62)}-${i}`;
    if (free(name)) return name;
  }
  return undefined;
}

/**
 * Map Discord channel `id` into `space` as `{id, name, mode: task}` (no `locations` key = every location of the space)
 * and create its memory dir. ONE locked write of workspace.yaml (the same lock as `/init-channel` and RegisterLocation);
 * the id and the name are re-checked under the lock, so two adoptions at once never share a name and a repeat of the
 * same id writes nothing. An empty slug (no ASCII letter or digit) uses `channel-<last 4 id digits>`. After the rename the registry is reloaded: the channel must load with that name, else the old
 * bytes are restored. The memory dir is made inside that check (a failure leaves no mapping and no dir). Never throws: a busy lock or a bad yaml is `failed` (logged).
 */
export function adoptChannel(
  home: string,
  space: string,
  id: string,
  discordName: string,
): AdoptResult {
  const log = logger.child({ module: "adopt-channel" });
  // A name with no ASCII letter or digit (CJK, emoji) falls back to `channel-<last 4 id digits>`.
  const base = slugChannelName(discordName) || `channel-${id.slice(-4)}`;
  let chosen: string | undefined;
  let reason: "already_mapped" | "no_free_name" | undefined;
  try {
    const refusal = updateWorkspaceYaml(
      home,
      space,
      (data) => {
        const channels = channelEntries(data.channels);
        if (channels.some((c) => c.id === id)) {
          reason = "already_mapped";
          return reason;
        }
        chosen = uniqueChannelName(new Set(channels.map((c) => String(c.name))), base);
        if (!chosen) {
          reason = "no_free_name";
          return "no free channel name";
        }
        data.channels = [...channels, { id, name: chosen, mode: "task" }];
        return undefined;
      },
      {
        // Runs after the rename: the channel must load AND its memory dir must be made, else the writer restores the old yaml.
        verify: () => {
          const loaded = loadWorkspaces(home)
            .workspaces.find((w) => w.name === space)
            ?.channelDefs.some((c) => c.id === id && c.name === chosen);
          if (!loaded || !chosen) return "channel did not load";
          const dir = workspacePaths(home).workspace(space).channel(chosen).root;
          const existed = existsSync(dir);
          try {
            ensureChannelDir(home, space, chosen);
          } catch (err) {
            if (!existed) rmSync(dir, { recursive: true, force: true }); // no half-made dir without a mapping
            throw err;
          }
          return undefined;
        },
      },
    );
    if (refusal) return { ok: false, reason: reason ?? "failed" };
    if (!chosen) return { ok: false, reason: "failed" };
    return { ok: true, name: chosen };
  } catch (err) {
    logEvent(log, "channel.adopt_failed", { space, channelId: id, err: errText(err) }, "warn");
    return { ok: false, reason: "failed" };
  }
}
