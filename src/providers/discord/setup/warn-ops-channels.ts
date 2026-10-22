import type { Logger } from "pino";
import type { Workspace } from "../../../workspaces/workspace-registry";

/** An ops channel id inside a workspace `channels:` is dropped (ingress never routes ops channels to a workspace): warn once each. */
export function warnOpsChannelsInWorkspaces(
  workspaces: Pick<Workspace, "name" | "channels">[],
  ops: Set<string>,
  log: Logger,
): void {
  for (const w of workspaces)
    for (const c of w.channels.filter((id) => ops.has(id)))
      log.warn(
        { workspace: w.name, channelId: c },
        "ops channel listed in workspace channels: dropped",
      );
}
