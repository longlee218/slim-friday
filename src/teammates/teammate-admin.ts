import type { Database } from "bun:sqlite";
import { HAIKU_MODEL, OPUS_MODEL, SONNET_MODEL } from "../config/model-ids";
import { CHIEF_OF_STAFF_ROLE } from "../roles/builtin/chief-of-staff-role";
import { findRole } from "../roles/role-registry";
import {
  archiveTeammate,
  insertTeammate,
  listActiveTeammates,
  type TeammatePatch,
  teammateByName,
  updateTeammate,
} from "../storage/teammate-store";
import { validateForKind } from "../tools/derive-tool-policy";
import { teammateFromPreset } from "./teammate-from-preset";
import { TEAMMATE_NAME_RE, type Teammate } from "./teammate-types";

/* The owner's `/teammate` operations, with no Discord in them: Discord parses the command, renders the reply and supplies
   the one thing only it can do (a private channel). Every check runs before the first side effect. */

/** What the core needs from its caller. */
export interface TeammateAdminDeps {
  db: Database;
  /** Discord-supplied: create the private channel `name` under `space` (category and `workspace.yaml` entry included); returns its id. */
  createPrivateChannel(spec: { space: string; name: string }): Promise<{ channelId: string }>;
}

/** A refused request: the message is for the owner. */
export class TeammateAdminError extends Error {}

/** Model shorthands the owner may type; any other value must be a full `claude-*` id. */
const MODEL_ALIASES: Record<string, string> = {
  haiku: HAIKU_MODEL,
  sonnet: SONNET_MODEL,
  opus: OPUS_MODEL,
};

/** The model id for what the owner typed, or a refusal. */
function modelId(typed: string): string {
  const id = MODEL_ALIASES[typed.toLowerCase()] ?? typed;
  if (!/^claude-[a-z0-9.-]+$/.test(id))
    throw new TeammateAdminError(
      `Unknown model \`${typed}\`. Use ${Object.keys(MODEL_ALIASES).join(", ")} or a full claude-* id.`,
    );
  return id;
}

/** Tool ids a teammate run can build, or a refusal naming the bad ones. */
function checkTools(ids: string[]): void {
  try {
    validateForKind(ids, "teammate");
  } catch (err) {
    throw new TeammateAdminError(err instanceof Error ? err.message : String(err));
  }
}

/** The active teammate called `name`, or a refusal. */
function mustFind(db: Database, name: string): Teammate {
  const t = teammateByName(db, name);
  if (!t) throw new TeammateAdminError(`No active teammate called \`${name}\`.`);
  return t;
}

/**
 * Create a teammate: validate (name, preset, model), create the channel, then insert the row. A failure after the channel
 * exists is reported by the caller (the channel is never deleted automatically).
 */
export async function createTeammate(
  d: TeammateAdminDeps,
  a: { space: string; name: string; preset?: string; model?: string; description?: string },
): Promise<{ teammate: Teammate; channelId: string }> {
  if (!TEAMMATE_NAME_RE.test(a.name))
    throw new TeammateAdminError("A name is 2-32 characters: a-z, 0-9 and dashes.");
  if (teammateByName(d.db, a.name))
    throw new TeammateAdminError(`A teammate called \`${a.name}\` already exists.`);
  const preset = findRole(a.preset ?? CHIEF_OF_STAFF_ROLE.name);
  if (!preset) throw new TeammateAdminError(`Unknown preset \`${a.preset}\`.`);
  const model = a.model ? modelId(a.model) : undefined;
  const { channelId } = await d.createPrivateChannel({ space: a.space, name: a.name });
  const teammate = teammateFromPreset(preset, {
    name: a.name,
    description: a.description ?? "",
    channelId,
    ...(model && { model }),
  });
  insertTeammate(d.db, teammate);
  return { teammate, channelId };
}

/** What `edit` may change (tools and skills as id lists). */
export type TeammateEdit = Pick<
  TeammatePatch,
  "title" | "instructions" | "description" | "model" | "tools" | "skills"
>;

/** Edit an active teammate. Tools must be valid for a teammate run, the model a known alias or `claude-*` id. */
export function editTeammate(d: TeammateAdminDeps, name: string, edit: TeammateEdit): Teammate {
  const t = mustFind(d.db, name);
  const patch: TeammatePatch = { ...edit, ...(edit.model && { model: modelId(edit.model) }) };
  if (patch.tools) checkTools(patch.tools);
  updateTeammate(d.db, t.id, patch);
  return mustFind(d.db, name);
}

/** Archive a teammate (its channel stays; messages there no longer run it). */
export function archiveTeammateByName(d: TeammateAdminDeps, name: string): Teammate {
  const t = mustFind(d.db, name);
  archiveTeammate(d.db, t.id);
  return t;
}

/** Every active teammate. */
export const listTeammates = (d: TeammateAdminDeps): Teammate[] => listActiveTeammates(d.db);
