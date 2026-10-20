import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { buildLocationsContext, type Location } from "../../locations/location-registry";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import { buildMemoryContext } from "../../memory/location-memory";
import { buildPersonaContext } from "../../memory/persona";
import type { RoleRunInput } from "../../orchestrator/run/role-run-types";
import type { RoleScope } from "../../orchestrator/run/role-scope-types";
import { runExtraContext } from "../../orchestrator/run/run-extra-context";
import { buildTeamMd } from "../../roles/prompts/team-md";
import { threadTitleNote } from "../../roles/prompts/thread-title-note";
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
  /** Locations of the channel (TEAM.md for the lead, registry and memory for a worker). */
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

/** `threadTitleNote` reads one thread row; this answers "a fresh thread with a placeholder name and no title". */
const FRESH_THREAD_DB = {
  query: () => ({ get: () => ({ placeholder: "preview", title: null }) }),
} as unknown as Database;

/** The persona block split at its `## <FILE>.md` headings into one layer per file. */
function personaLayers(persona: string): PromptLayer[] {
  const parts = persona.split(/^(?=## (?:AGENTS|TEAM|IDENTITY|SOUL|USER)\.md$)/m).filter(Boolean);
  return parts.map((p) => ({ name: /^## (\S+)/.exec(p)?.[1] ?? "persona", text: p.trimEnd() }));
}

/**
 * The system prompt of a role exactly as a run assembles it: the extra context comes from the real `runExtraContext`
 * (persona, TEAM.md, memory, registry, title note), the final text from the real `buildSystemPrompt`. The layers are
 * labeled by matching each context block with the piece that produced it; an unmatched block is kept as "context".
 */
export function buildPromptPreview(role: RoleDefinition, i: PreviewInput): PromptPreview {
  const control = role.kind === "control";
  const workspace = control ? undefined : (i.workspace ?? PLACEHOLDER_WORKSPACE);
  const locations = i.locations ?? [];
  const team = role.kind === "lead" ? buildTeamMd({ locations }) : undefined;
  const hasTitlePort = role.kind === "lead" && !!role.mcpTools?.includes(ORCHESTRATE_TOOL);
  const blocks = runExtraContext({
    db: FRESH_THREAD_DB,
    config: { agentHome: i.agentHome } as AgentConfig,
    i: { workspace, channel: i.channel, team, threadId: "preview" } as RoleRunInput,
    s: { scope: locations } as RoleScope,
    role,
    hasTitlePort,
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
    [
      "memory",
      workspace &&
        buildMemoryContext(
          i.agentHome,
          workspace,
          i.channel,
          locations.map((l) => l.name),
          role.kind !== "worker",
        ),
    ],
    ["thread-title note (fresh thread only)", threadTitleNote(FRESH_THREAD_DB, "preview", true)[0]],
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
