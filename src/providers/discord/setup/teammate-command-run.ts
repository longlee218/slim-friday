import type { Database } from "bun:sqlite";
import { logEvent, logger } from "../../../observability/logger";
import { errText } from "../../../observability/redact";
import {
  archiveTeammateByName,
  createTeammate,
  editTeammate,
  listTeammates,
  TeammateAdminError,
} from "../../../teammates/teammate-admin";
import { parseTeammateCommand, TEAMMATE_USAGE } from "../../../teammates/teammate-command";
import { createTeammateChannel, type InitDeps } from "./teammate-channel";

const log = logger.child({ module: "teammate-command" });

/** Run the argument text of `/teammate` (owner and control-channel gate already passed) and return the reply. Never throws. */
export async function runTeammateCommand(
  db: Database,
  init: InitDeps,
  arg: string,
): Promise<string> {
  const cmd = parseTeammateCommand(arg);
  if (!cmd) return `Usage:\n${TEAMMATE_USAGE}`;
  const deps = {
    db,
    createPrivateChannel: (spec: { space: string; name: string }) =>
      createTeammateChannel(init, spec),
  };
  try {
    switch (cmd.kind) {
      case "create": {
        const r = await createTeammate(deps, cmd);
        logEvent(log, "teammate.created", { name: r.teammate.name });
        return `Created teammate \`${r.teammate.name}\` in <#${r.channelId}> (model ${r.teammate.model}). Set its profile with \`/teammate edit ${r.teammate.name} description <text>\`.`;
      }
      case "list": {
        const all = listTeammates(deps);
        return all.length
          ? all
              .map(
                (t) =>
                  `- \`${t.name}\` <#${t.channelId}> ${t.preset}, ${t.model}, ${t.tools.length} tools`,
              )
              .join("\n")
          : "No teammates yet. Create one with `/teammate create <space> <name> [model]`.";
      }
      case "edit": {
        const t = editTeammate(deps, cmd.name, cmd.edit);
        const fresh = cmd.edit.model || cmd.edit.tools || cmd.edit.skills;
        logEvent(log, "teammate.edited", { name: t.name, fields: Object.keys(cmd.edit) });
        return `Updated \`${t.name}\`.${fresh ? " The next message starts a fresh session." : ""}`;
      }
      case "archive": {
        const t = archiveTeammateByName(deps, cmd.name);
        logEvent(log, "teammate.archived", { name: t.name });
        return `Archived \`${t.name}\`. Its channel <#${t.channelId}> stays; messages there no longer run it.`;
      }
    }
  } catch (err) {
    if (err instanceof TeammateAdminError) return err.message;
    log.error({ err: errText(err) }, "teammate command failed");
    return "The command failed (see logs).";
  }
}
