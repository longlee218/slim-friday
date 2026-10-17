import { homedir } from "node:os";
import { real } from "../locations/location-registry";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { inspectLocation, type LocationCandidate } from "./location-candidate";
import { channelLocations, channelOf } from "./task-workspace";
import { loadWorkspaces } from "./workspace-registry";
import { addLocationEntry, linkChannelLocation, updateWorkspaceYaml } from "./workspace-yaml-write";

/** Outcome of `registerLocation`: the name now usable, whether an entry was added, whether the channel sees it. */
export type RegisterResult =
  | { ok: true; name: string; added: boolean; linked: boolean }
  | { ok: false; reason: string };

/**
 * Register `candidate` (from `inspectLocation`) in `space` and let `channelId` use it, in ONE locked write of workspace.yaml.
 * Under the lock the path is inspected AGAIN (the dir may have changed since the owner confirmed), the old bytes are
 * backed up, the entry is added unless `candidate.existing`, and the channel list is extended when it is an explicit list.
 * After the rename the registry is reloaded: the location must load and the channel must see it, else the old bytes are
 * restored and the call refuses. Never throws for expected failures (busy lock, bad yaml): returns a reason.
 */
export function registerLocation(
  home: string,
  space: string,
  channelId: string,
  candidate: LocationCandidate,
  userHome: string = homedir(),
  now: Date = new Date(),
): RegisterResult {
  const log = logger.child({ module: "register-location" });
  let fresh: LocationCandidate | undefined;
  try {
    const refusal = updateWorkspaceYaml(
      home,
      space,
      (data) => {
        const again = inspectLocation(home, space, candidate.realPath, userHome, {
          sensitive: false, // path checks only: the slow search ran before the owner confirmed
        });
        if (!again.ok) return again.reason;
        fresh = again;
        if (!again.existing)
          addLocationEntry(data, {
            name: again.name,
            path: again.realPath,
            description: again.description,
          });
        return linkChannelLocation(data, channelId, again.name);
      },
      {
        backupAt: now,
        // The registry must load the entry and the channel must see it, or the file is restored.
        verify: () => {
          const ws = loadWorkspaces(home, userHome).workspaces.find((w) => w.name === space);
          const channel = ws && channelOf(ws, channelId);
          const seen = ws && channel && channelLocations(ws, channel);
          return seen?.some((l) => real(l.path) === candidate.realPath)
            ? undefined
            : "the registry did not accept the location";
        },
      },
    );
    if (refusal || !fresh) return { ok: false, reason: refusal ?? "not registered" };
    logEvent(log, "location.registered", { space, location: fresh.name, added: !fresh.existing });
    return { ok: true, name: fresh.name, added: !fresh.existing, linked: true };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}
