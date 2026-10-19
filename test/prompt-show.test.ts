import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AgentConfig } from "../src/config/agent-config";
import type { RoleRunInput } from "../src/orchestrator/run/role-run-types";
import type { RoleScope } from "../src/orchestrator/run/role-scope-types";
import { runExtraContext } from "../src/orchestrator/run/run-extra-context";
import { buildTeamMd } from "../src/roles/prompts/team-md";
import { getRole } from "../src/roles/role-registry";
import { makeDefaultHome } from "../src/runtime/prompt-preview/default-home";
import { PREVIEW_ROLES, renderPromptShow } from "../src/runtime/prompt-preview/show";
import { buildSystemPrompt, systemPromptText } from "../src/runtime/system-prompt";
import { FULL_CTX } from "./mcp-ctx-fixture";

const home = makeDefaultHome();
const show = (roles: string[], tools = false) =>
  renderPromptShow({ roles, agentHome: home, tools, skills: true, ctx: FULL_CTX });

test("lead, planner and scout show every layer header and a totals table", () => {
  const md = show(["lead", "planner", "scout"], true);
  for (const h of [
    "### role contract (promptSections)",
    "### COMMON safety",
    "### AGENTS.md",
    "### TEAM.md",
    "### IDENTITY.md",
    "### SOUL.md",
    "### USER.md",
    "### registry (locations of the run)",
    "## Skills listed",
    "## Tools",
    "### MCP server orchestration",
    "## Totals",
  ])
    expect(md).toContain(h);
  expect(md).toMatch(/### role contract \(promptSections\) - \d+ chars, ~\d+ tokens/);
  expect(md).toContain("# Summary");
});

test("--all covers every role", () => {
  const md = show(PREVIEW_ROLES);
  for (const r of PREVIEW_ROLES) expect(md).toContain(`\n# ${r}\n`);
});

test("the lead's system prompt length equals what a run assembles", () => {
  const role = getRole("lead");
  // The run path: runExtraContext blocks joined into buildSystemPrompt (sdk-options.ts), same inputs as the preview.
  const blocks = runExtraContext({
    db: {
      query: () => ({ get: () => ({ placeholder: "preview", title: null }) }),
    } as unknown as Database,
    config: { agentHome: home } as AgentConfig,
    i: {
      workspace: "preview",
      team: buildTeamMd({ locations: [] }),
      threadId: "t",
    } as RoleRunInput,
    s: { scope: [] } as unknown as RoleScope,
    role,
    hasTitlePort: true,
  });
  const runtime = systemPromptText(
    buildSystemPrompt(blocks.filter(Boolean).join("\n\n"), role, { worktreesDir: undefined }),
  );
  const md = show(["lead"]);
  expect(md).toContain(`| system prompt (layers + separators) | ${runtime.length} |`);
  expect(md).toContain(runtime.slice(0, 80));
});
