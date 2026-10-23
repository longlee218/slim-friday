import type { Database } from "bun:sqlite";
import { EFFECT_TOOL_NAMES } from "../effects/effect-tool-names";
import { docOfRow } from "../orchestrator/plan/plan-doc";
import { effectScope } from "../storage/effect-log-store";
import { childrenOf } from "../storage/owned-item-store";
import { newestApprovedVersion } from "../storage/work-plan-store";
import {
  type DispatchEnvelope,
  defaultEnvelope,
  type EffectGrant,
  envelopeFromPlan,
  envelopeWithGrants,
} from "./envelope";

/* Rebuild a goal's envelope from what the db holds, at the start of each worker run (so a restart or a plan revision is
   picked up, and nothing lives only in memory). */

/** Id and tool name of the audit row that stores the grants the owner confirmed at a DIRECT / DELEGATE dispatch. */
export const GRANT_TOOL = "EnvelopeGrant";
export const grantRowId = (goalId: string): string => `grant:${goalId}`;

/** Grants of a goal's dispatch row; a missing or corrupt row reads as no grants (fail closed: fewer permissions). */
function storedGrants(db: Database, goalId: string): EffectGrant[] {
  const scope = effectScope(db, grantRowId(goalId));
  if (scope === undefined) return [];
  try {
    const list = JSON.parse(scope) as EffectGrant[];
    return list.filter(
      (g) =>
        (EFFECT_TOOL_NAMES as readonly string[]).includes(g?.tool) &&
        typeof g.scope?.location === "string",
    );
  } catch {
    return [];
  }
}

/**
 * The envelope of a goal: its newest APPROVED plan version (PLAN), else the grants stored at the dispatch (DIRECT /
 * DELEGATE), else the default (R0 + R1, deletes to the trash within the bounds).
 */
export function loadEnvelope(
  db: Database,
  goalId: string,
  locations: string[],
  goalDir: string,
): DispatchEnvelope {
  const base = defaultEnvelope(goalId, locations, goalDir);
  const approved = newestApprovedVersion(db, goalId);
  if (approved)
    return envelopeFromPlan(base, docOfRow(approved).envelope, {
      planId: approved.id,
      version: approved.version,
    });
  return envelopeWithGrants(base, storedGrants(db, goalId));
}

/**
 * Location names a goal works in: the ones its items (and this item) are pinned to. Nothing pinned and one channel
 * location = that one; nothing pinned among several = none (every delete there asks the owner: fail closed). The other
 * channel locations are never in the envelope by default.
 */
export function goalLocations(
  db: Database,
  goalId: string,
  itemLocation: string | null,
  channelLocations: string[],
): string[] {
  const pinned = new Set(
    [itemLocation, ...childrenOf(db, goalId).map((i) => i.location)].filter(
      (l): l is string => !!l && channelLocations.includes(l),
    ),
  );
  if (pinned.size > 0) return [...pinned];
  return channelLocations.length === 1 ? channelLocations : [];
}
