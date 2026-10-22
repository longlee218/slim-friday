import type { AgentConfig } from "../../config/agent-config";
import { buildLocationsContext, type Location } from "../../locations/location-registry";
import { buildMemoryContext } from "../../memory/channel-memory";
import { buildPersonaContext } from "../../memory/persona";
import type { RoleRunInput } from "../../orchestrator/run/role-run-types";
import type { RoleScope } from "../../orchestrator/run/role-scope-types";
import { runExtraContext } from "../../orchestrator/run/run-extra-context";
import { buildTeamMd } from "../../roles/prompts/team-md";
import type { RoleDefinition } from "../../roles/role-types";
import { preloadedSkillsText } from "../skills-plugin/preload-skills";
import { requiredSkillsText } from "../skills-plugin/required-skills";
import { buildSystemPrompt, type SystemPrompt, systemPromptText } from "../system-prompt";

/** One labeled slice of the system prompt, in prompt order. */
export interface PromptLayer {
  name: string;
  text: string;
}

/** What a preview is built for. */
export interface PreviewInput {
  agentHome: string;
  /** Workspace of the run; omitted = a placeholder one (its persona files fall back to the root ones). Ignored for the control role. */
  workspace?: string;
  channel?: string;
  /** Locations of the channel (TEAM.md for the lead, registry for a worker). */
  locations?: Location[];
  /** Worktrees dir a writing role is told about; omitted = no line. */
  worktreesDir?: string;
}

/** The assembled prompt of a role: the SDK value, its text and the labeled layers. */
export interface PromptPreview {
  systemPrompt: SystemPrompt;
  text: string;
  layers: PromptLayer[];
}

/** Workspace name used when none is given (not a real folder: reads fall back to the root files). */
const PLACEHOLDER_WORKSPACE = "preview";

/** The persona block split into one layer per owner file (`<file name="…">`) and one for `<team>`. */
function personaLayers(persona: string): PromptLayer[] {
  const files = [...persona.matchAll(/<file name="([^"]+)">\n[\s\S]*?\n<\/file>/g)];
  const team = /<team>\n[\s\S]*<\/team>/.exec(persona);
  return [
    ...files.map((m) => ({ name: m[1] ?? "persona", text: m[0] })),
    ...(team ? [{ name: "TEAM.md", text: team[0] }] : []),
  ];
}

/**
 * The system prompt of a role exactly as a run assembles it: the extra context comes from the real `runExtraContext`
 * (persona, TEAM.md, worker memory, registry; the lead's memory and title note are in its user turn, not here), the final text from the real `buildSystemPrompt`. The layers are
 * labeled by matching each context block with the piece that produced it; an unmatched block is kept as "context".
 */
export function buildPromptPreview(role: RoleDefinition, i: PreviewInput): PromptPreview {
  const control = role.kind === "control";
  const workspace = control ? undefined : (i.workspace ?? PLACEHOLDER_WORKSPACE);
  const locations = i.locations ?? [];
  const team = role.kind === "lead" ? buildTeamMd({ locations }) : undefined;
  const blocks = runExtraContext({
    config: { agentHome: i.agentHome } as AgentConfig,
    i: { workspace, channel: i.channel, team, threadId: "preview" } as RoleRunInput,
    s: { scope: locations } as RoleScope,
    role,
  });
  const opts = { worktreesDir: i.worktreesDir };
  const systemPrompt = buildSystemPrompt(blocks.filter(Boolean).join("\n\n"), role, opts);
  const text = systemPromptText(systemPrompt);

  // The pieces the context blocks are made of, rebuilt with the same arguments, to name each block.
  const persona =
    role.kind === "worker" ? "" : buildPersonaContext(i.agentHome, workspace, i.channel, team).text;
  const known: [string, string | undefined][] = [
    [
      "registry (locations of the run)",
      workspace && buildLocationsContext(workspace, locations, true),
    ],
    ["memory", workspace && buildMemoryContext(i.agentHome, workspace, i.channel)],
  ];
  const contract = role.promptSections(opts).join("\n");
  const rules = systemPromptText(buildSystemPrompt("", role, opts));
  // The preloaded skill text and the required-skills line are the tail of the rules (after COMMON), so it is cut off to label each layer on its own.
  const skills = preloadedSkillsText(role.preloadSkills);
  const required = requiredSkillsText(role.requiredSkills);
  const tail = [skills, required].filter(Boolean).join("\n\n");
  const common = tail ? rules.slice(0, rules.length - tail.length - 2) : rules;
  const layers: PromptLayer[] = [
    { name: "role contract (promptSections)", text: contract },
    { name: "COMMON safety", text: common.slice(contract ? contract.length + 1 : 0) },
    ...(skills ? [{ name: "preloaded skills", text: skills }] : []),
    ...(required ? [{ name: "required skills", text: required }] : []),
  ];
  for (const b of blocks)
    if (persona && b === persona) layers.push(...personaLayers(b));
    else layers.push({ name: known.find(([, t]) => t === b)?.[0] ?? "context", text: b });
  return { systemPrompt, text, layers };
}
