import { join } from "node:path";
import { workspacePaths } from "../../src/config/workspace-paths";
import { getRole } from "../../src/roles/role-registry";
import { buildPromptPreview } from "../../src/runtime/prompt-preview/prompt-layers";
import { PREVIEW_ROLES } from "../../src/runtime/prompt-preview/show";
import { listedSkills } from "../../src/runtime/prompt-preview/skill-listing";
import { toolDefinitions } from "../../src/runtime/prompt-preview/tool-definitions";
import { loadWorkspaces } from "../../src/workspaces/workspace-registry";
import { FULL_CTX } from "../../test/mcp-ctx-fixture";
import { AGENT_HOME } from "./db";

/** A role with no basePrompt runs on the SDK coding preset. */
const PRESET = "claude_code";

/** Workspaces and their channels: the scopes a prompt can be built for (persona, memory, locations differ). */
export function promptScopes() {
  return {
    roles: PREVIEW_ROLES.map((name) => {
      const r = getRole(name);
      return { name, model: r.model ?? null, kind: r.kind, base: r.basePrompt ?? PRESET };
    }),
    workspaces: loadWorkspaces(AGENT_HOME).workspaces.map((w) => ({
      name: w.name,
      channels: w.channelDefs.map((c) => c.name),
    })),
  };
}

/**
 * The exact system prompt of one role in one workspace/channel, built by the runtime's own functions (the same as
 * `bun run prompt:show`): labeled layers in prompt order, the skills it is offered, the tool definitions it gets.
 */
export function promptOf(roleName: string, workspace?: string, channel?: string) {
  if (!PREVIEW_ROLES.includes(roleName)) return null;
  const role = getRole(roleName);
  const ws = workspace ? loadWorkspaces(AGENT_HOME).workspaces.find((w) => w.name === workspace) : undefined;
  const allowed = ws?.channelDefs.find((c) => c.name === channel)?.locations;
  const locations = (ws?.locations ?? []).filter((l) => !allowed || allowed.includes(l.name));
  const preview = buildPromptPreview(role, {
    agentHome: AGENT_HOME,
    workspace: ws?.name,
    channel: ws ? channel : undefined,
    locations,
    worktreesDir: ws
      ? workspacePaths(AGENT_HOME).workspace(ws.name).worktrees
      : join(AGENT_HOME, "workspaces", "<workspace>", "worktrees"),
  });
  const tools = toolDefinitions(role, FULL_CTX);
  return {
    role: {
      name: role.name,
      model: role.model ?? null,
      base: role.basePrompt ?? PRESET,
      skills: role.skills ?? [],
      preloadSkills: role.preloadSkills ?? [],
      budgetUsd: role.budgetUsd ?? null,
      limits: role.limits ?? null,
      capabilities: role.capabilities ?? [],
    },
    // The preview labels an unmatched block "context"; for workers that block is the injected location rules.
    layers: preview.layers.map((l) => ({
      name: l.name === "context" && l.text.includes("## Location rules") ? "location rules" : l.name,
      chars: l.text.length,
      text: l.text,
    })),
    text: preview.text,
    skills: listedSkills(role, AGENT_HOME, ws?.name),
    tools: tools.tools.map((t) => ({ name: t.name, server: t.server, description: t.description, chars: t.chars })),
    externalTools: tools.external,
  };
}
