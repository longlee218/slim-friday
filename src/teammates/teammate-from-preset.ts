import type { Capability, RoleDefinition } from "../roles/role-types";
import { CAPABILITY_TOOLS } from "../tools/capability-tools";
import { toolIdsOf } from "../tools/role-policy";
import type { Teammate } from "./teammate-types";

/* A teammate is a copy of a preset's VALUES (model, tools, skills, limits). The prompt text is not copied: it is the preset's
   own and is rendered at run time, so a repo fix to a prompt reaches every teammate while a preset change never silently
   changes a teammate's tools or model. A preset is a registry role until presets become files. */

const GROUPS = new Set<string>(Object.keys(CAPABILITY_TOOLS));

/** The values a new teammate copies from `preset` (budget and turn limits stay the preset's until the owner sets them). */
export function teammateValuesOf(
  preset: RoleDefinition,
): Pick<Teammate, "preset" | "model" | "tools" | "skills"> {
  return {
    preset: preset.name,
    model: preset.model,
    tools: toolIdsOf(preset),
    skills: [...(preset.skills ?? [])],
  };
}

/** A new teammate (not yet stored) from a preset. */
export function teammateFromPreset(
  preset: RoleDefinition,
  o: {
    id?: string;
    name: string;
    description: string;
    title?: string;
    instructions?: string;
    channelId: string;
    model?: string;
    now?: number;
  },
): Teammate {
  const now = o.now ?? Date.now();
  return {
    id: o.id ?? crypto.randomUUID(),
    name: o.name,
    title: o.title ?? "",
    instructions: o.instructions ?? "",
    description: o.description,
    channelId: o.channelId,
    ...teammateValuesOf(preset),
    ...(o.model && { model: o.model }),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The role a teammate run uses: the preset's role overlaid with the row (model, tools -> capabilities and `mcpTools`, skills,
 * limits). Engine role name stays the preset's (`chief-of-staff`): goal ownership, effect ports and episodes key on it; the
 * teammate's identity is `turns.teammate_id`. `Orchestrate` decides whether the method skill is preloaded.
 */
export function roleFromTeammate(preset: RoleDefinition, t: Teammate): RoleDefinition {
  const skills = t.skills;
  const preload = (preset.preloadSkills ?? []).filter((s) => skills.includes(s));
  return {
    ...preset,
    model: t.model,
    capabilities: t.tools.filter((id) => GROUPS.has(id)) as Capability[],
    mcpTools: t.tools.filter((id) => !GROUPS.has(id)),
    skills,
    preloadSkills: preload,
    requiredSkills: (preset.requiredSkills ?? []).filter((s) => skills.includes(s)),
    ...(t.budgetUsd !== undefined && { budgetUsd: t.budgetUsd }),
    limits: { ...preset.limits, ...(t.maxTurns !== undefined && { maxTurns: t.maxTurns }) },
  };
}
