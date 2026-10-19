import { join } from "node:path";
import { workspacePaths } from "../../config/workspace-paths";
import type { Location } from "../../locations/location-registry";
import type { RunCtx } from "../../mcp/manifest-types";
import { getRole } from "../../roles/role-registry";
import { loadWorkspaces } from "../../workspaces/workspace-registry";
import { buildPromptPreview } from "./prompt-layers";
import { type RoleStats, renderRole, renderSummary } from "./render-preview";
import { listedSkills } from "./skill-listing";
import { toolDefinitions } from "./tool-definitions";

/** Roles `prompt:show --all` covers, lead first. */
export const PREVIEW_ROLES = [
  "lead",
  "planner",
  "scout",
  "developer",
  "tester",
  "devops",
  "hacker",
  "solution-architect",
  "designer",
  "humanizer-writer",
  "discord-manager",
];

/** Options of one `prompt:show` run. */
export interface ShowOptions {
  /** Role names to show. */
  roles: string[];
  agentHome: string;
  workspace?: string;
  channel?: string;
  /** Render the tool definitions. */
  tools: boolean;
  /** List skills (false = `--no-skills`). */
  skills: boolean;
  /** Run ctx with every part, so every tool of a role is built (the caller supplies a fake one). */
  ctx: RunCtx;
}

/** Locations a channel of the workspace may use (the channel's `locations` subset, else all); [] for an unknown workspace. */
function channelLocations(home: string, workspace?: string, channel?: string): Location[] {
  if (!workspace) return [];
  const ws = loadWorkspaces(home).workspaces.find((w) => w.name === workspace);
  const allowed = ws?.channelDefs.find((c) => c.name === channel)?.locations;
  return (ws?.locations ?? []).filter((l) => !allowed || allowed.includes(l.name));
}

/** Markdown of the system prompt layers (and tools, skills) of each role, behind a summary table when several. */
export function renderPromptShow(o: ShowOptions): string {
  const locations = channelLocations(o.agentHome, o.workspace, o.channel);
  const worktreesDir = o.workspace
    ? workspacePaths(o.agentHome).workspace(o.workspace).worktrees
    : join(o.agentHome, "workspaces", "<workspace>", "worktrees");
  const sections: string[] = [];
  const stats: RoleStats[] = [];
  for (const name of o.roles) {
    const role = getRole(name);
    const { md, stats: s } = renderRole({
      role,
      preview: buildPromptPreview(role, {
        agentHome: o.agentHome,
        workspace: o.workspace,
        channel: o.channel,
        locations,
        worktreesDir,
      }),
      skills: o.skills ? listedSkills(role, o.agentHome, o.workspace) : [],
      tools: toolDefinitions(role, o.ctx),
      showTools: o.tools,
    });
    sections.push(md);
    stats.push(s);
  }
  const summary = o.roles.length > 1 ? `# Summary\n\n${renderSummary(stats)}\n\n` : "";
  return `${summary}${sections.join("\n\n---\n\n")}\n`;
}
