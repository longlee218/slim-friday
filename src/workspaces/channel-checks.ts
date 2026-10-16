import { CHANNEL_NAME } from "../config/workspace-paths";
import { logEvent, logger } from "../observability/logger";
import type { Workspace, WorkspaceChannel } from "./workspace-registry";

/**
 * Validate the channel list of one space. A name that is not a valid dir name, or that an EARLIER channel of the space already uses,
 * is warned about and dropped (the first keeps the name: a live channel never goes dark). A `locations` list
 * FAILS CLOSED: it is exactly the known names (possibly empty = no location, the run works in `cwd/`);
 * unknown names are warned about and ignored. Only an absent `locations` means every location of the space.
 */
export function checkChannels(
  space: string,
  raw: WorkspaceChannel[],
  locationNames: string[],
): WorkspaceChannel[] {
  const log = logger.child({ module: "workspace-registry" });
  const seen = new Set<string>();
  const kept: WorkspaceChannel[] = [];
  for (const c of raw) {
    if (!CHANNEL_NAME.test(c.name) || seen.has(c.name)) {
      logEvent(log, "channel.bad_name", { workspace: space, name: c.name }, "warn");
      continue;
    }
    seen.add(c.name);
    if (!c.locations) {
      kept.push(c);
      continue;
    }
    const unknown = c.locations.filter((n) => !locationNames.includes(n));
    if (unknown.length)
      logEvent(
        log,
        "channel.unknown_location",
        { workspace: space, name: c.name, unknown },
        "warn",
      );
    kept.push({ ...c, locations: c.locations.filter((n) => locationNames.includes(n)) });
  }
  return kept;
}

/** Drop channel ids that two workspaces both list (from both: routing must never be ambiguous). */
export function dropDuplicateChannels(workspaces: Workspace[]): void {
  const owners = new Map<string, number>();
  for (const w of workspaces)
    for (const c of new Set(w.channels)) owners.set(c, (owners.get(c) ?? 0) + 1);
  const dup = [...owners].filter(([, n]) => n > 1).map(([c]) => c);
  if (!dup.length) return;
  logEvent(
    logger.child({ module: "workspace-registry" }),
    "channel.duplicate",
    { channels: dup },
    "warn",
  );
  for (const w of workspaces) {
    w.channels = w.channels.filter((c) => !dup.includes(c));
    w.channelDefs = w.channelDefs.filter((c) => !dup.includes(c.id));
  }
}
