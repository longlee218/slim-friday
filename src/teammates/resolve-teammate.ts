import type { Database } from "bun:sqlite";
import { CHIEF_OF_STAFF } from "../roles/role-names";
import { getRole } from "../roles/role-registry";
import type { RoleDefinition } from "../roles/role-types";
import {
  archivedTeammateByChannel,
  listActiveTeammates,
  teammateByChannel,
} from "../storage/teammate-store";
import { validateForKind } from "../tools/derive-tool-policy";
import { toolIdsOf } from "../tools/role-policy";
import { configMark } from "./config-mark";
import { roleFromTeammate } from "./teammate-from-preset";
import { directoryBlock, profileBlock } from "./teammate-prompt-blocks";
import type { Teammate } from "./teammate-types";

/** What a channel runs as. */
export type TeammateResolution =
  /** No row: the default chief-of-staff; `promptBlock` is the directory of the active teammates (absent when there are none). */
  | { ok: true; role: RoleDefinition; promptBlock?: string }
  /** A row: its role, the mark of its config, and the profile + directory text of its system prompt. */
  | { ok: true; teammate: Teammate; role: RoleDefinition; configMark: string; promptBlock: string }
  /** A row that cannot run (unknown preset, a tool id no teammate may hold): refused, never the default. */
  | { ok: false; teammate: Teammate; reason: string };

/**
 * The role of the run in `channelId`. Fail closed: a row that is invalid says why and runs nothing, so a bad tool list can
 * never fall back to the default role's tools (or to more tools than the owner chose).
 */
export function resolveTeammate(db: Database, channelId: string): TeammateResolution {
  const teammate = teammateByChannel(db, channelId);
  if (!teammate) {
    // An archived teammate keeps its channel: it must not quietly turn into the default teammate.
    const archived = archivedTeammateByChannel(db, channelId);
    if (archived) return { ok: false, teammate: archived, reason: "it is archived" };
    const directory = directoryBlock(listActiveTeammates(db), "");
    return {
      ok: true,
      role: getRole(CHIEF_OF_STAFF),
      ...(directory && { promptBlock: directory }),
    };
  }
  let preset: RoleDefinition;
  try {
    preset = getRole(teammate.preset);
  } catch {
    return { ok: false, teammate, reason: `unknown preset ${teammate.preset}` };
  }
  const role = roleFromTeammate(preset, teammate);
  try {
    validateForKind(toolIdsOf(role), "teammate");
  } catch (err) {
    return { ok: false, teammate, reason: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    teammate,
    role,
    configMark: configMark(teammate),
    promptBlock: [profileBlock(teammate), directoryBlock(listActiveTeammates(db), teammate.id)]
      .filter(Boolean)
      .join("\n\n"),
  };
}
