import type { RoleDefinition } from "../../roles/role-types";
import { policyOf } from "../../tools/role-policy";
import { toolsFor } from "../../tools/tool-catalog";
import type { PromptPreview } from "./prompt-layers";
import { summarizeSchema } from "./schema-summary";
import type { ListedSkill } from "./skill-listing";
import type { ToolDef } from "./tool-definitions";

/** Approx tokens of a text: chars / 4 (the repo's measure). */
export const tokens = (chars: number): number => Math.round(chars / 4);

/** Chars and totals of one rendered role, for the summary table. */
export interface RoleStats {
  role: string;
  base: "custom" | "preset";
  systemChars: number;
  toolChars: number;
  skillChars: number;
}

/** What one role section is rendered from. */
export interface RoleView {
  role: RoleDefinition;
  preview: PromptPreview;
  skills: ListedSkill[];
  tools: { tools: ToolDef[]; external: string[] };
  /** Render the tools section (the totals always count the tools). */
  showTools: boolean;
}

/** The listing line of a skill: what the run shows the model (`- name: description`). */
const skillLine = (s: ListedSkill): string => `- ${s.name}: ${s.description}`;

/** Fenced block that survives backticks inside the text. */
const fence = (text: string): string => `~~~~text\n${text}\n~~~~`;

/** Markdown section of one role; returns it with its stats. */
export function renderRole(v: RoleView): { md: string; stats: RoleStats } {
  const { role, preview, skills, tools } = v;
  const custom = role.basePrompt === "custom";
  const skillChars = skills.map(skillLine).join("\n").length;
  const toolChars = tools.tools.reduce((n, t) => n + t.chars, 0);
  const out: string[] = [
    `# ${role.name}`,
    "",
    `- model: ${role.model}; permissionMode: ${role.permissionMode ?? "default"}; maxTurns: ${role.limits.maxTurns}; budget: $${role.budgetUsd}`,
    `- base: ${custom ? "custom (our text is the whole system prompt; the SDK adds its billing header + one identity line, tools and the environment block)" : "claude_code preset, our text appended"}`,
    `- Skill tool: ${policyOf(role).ids.has("skills") ? "available" : "NOT available"}`,
    "",
    "## System prompt layers (in order)",
  ];
  for (const l of preview.layers)
    out.push(
      "",
      `### ${l.name} - ${l.text.length} chars, ~${tokens(l.text.length)} tokens`,
      "",
      fence(l.text),
    );
  out.push(
    "",
    `## Skills listed (${skills.length}) - ${skillChars} chars, ~${tokens(skillChars)} tokens`,
    "",
  );
  out.push(...(skills.length ? skills.map(skillLine) : ["- none"]));
  if (v.showTools) {
    out.push(
      "",
      `## Tools - ${toolChars} chars of MCP definitions, ~${tokens(toolChars)} tokens`,
      "",
    );
    out.push(`Built-in (SDK): ${toolsFor(role).join(", ") || "none"}`, "");
    const servers = [...new Set(tools.tools.map((t) => t.server))];
    for (const s of servers) {
      out.push(`### MCP server ${s}`);
      for (const t of tools.tools.filter((x) => x.server === s)) {
        out.push(
          "",
          `#### ${t.name} (${t.chars} chars)`,
          "",
          t.description || "(no description)",
          "",
        );
        out.push(...summarizeSchema(t.schema));
      }
      out.push("");
    }
    for (const e of tools.external)
      out.push(`### MCP server ${e} (external http or stdio: no definition offline)`);
  }
  const sys = preview.text.length;
  out.push(
    "",
    "## Totals",
    "",
    "| item | chars | ~tokens |",
    "|---|---|---|",
    `| system prompt (layers + separators) | ${sys} | ${tokens(sys)} |`,
    `| MCP tool schemas | ${toolChars} | ${tokens(toolChars)} |`,
    `| skills description | ${skillChars} | ${tokens(skillChars)} |`,
  );
  return {
    md: out.join("\n"),
    stats: {
      role: role.name,
      base: custom ? "custom" : "preset",
      systemChars: sys,
      toolChars,
      skillChars,
    },
  };
}

/** Summary table across roles. */
export function renderSummary(stats: RoleStats[]): string {
  const rows = stats.map(
    (s) =>
      `| ${s.role} | ${s.base} | ${s.systemChars} | ${tokens(s.systemChars)} | ${s.toolChars} | ${tokens(s.toolChars)} | ${s.skillChars} |`,
  );
  return [
    "| role | base | system chars | ~tokens | tool schema chars | ~tokens | skills chars |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
