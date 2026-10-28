import type { BotDto, GroupDto, McpServerDto, SkillDto } from "@friday/contracts";
import type { BotEntry, GroupEntry, McpEntry, SkillEntry } from "@friday/core";

/** A bot as the web app sees it; explicit fields so engine-only ones (e.g. dirs) never leak. */
export function toBotDto(b: BotEntry, avatarUrl?: string): BotDto {
  return {
    id: b.id,
    name: b.name,
    title: b.title,
    instructions: b.instructions,
    model: b.model,
    tools: b.tools,
    skills: b.skills,
    // Subagents are not editable here and the entry does not carry them.
    subagents: [],
    workspaces: b.workspaces,
    shipped: b.shipped,
    deletable: b.deletable,
    ...(b.effort && { effort: b.effort }),
    ...(b.maxEffort && { maxEffort: b.maxEffort }),
    ...(b.autonomy && { autonomy: b.autonomy }),
    ...(b.avatar && { avatar: b.avatar }),
    ...(avatarUrl && { avatarUrl }),
    ...(b.computer && { computer: b.computer }),
  };
}

/** A group as the web app sees it. */
export function toGroupDto(g: GroupEntry, avatarUrl?: string): GroupDto {
  return {
    id: g.id,
    name: g.name,
    members: g.members,
    entryBot: g.entryBot,
    workspaces: g.workspaces,
    instructions: g.instructions,
    ...(g.avatar && { avatar: g.avatar }),
    ...(avatarUrl && { avatarUrl }),
  };
}

/** An env reference as the only allowed secret form in an MCP env or header value. */
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const REDACTED = "••••";

/** A map of env or header values with every value that is not exactly a reference replaced. */
function redactMap(m: Record<string, string> | undefined): Record<string, string> | undefined {
  return (
    m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, ENV_REF.test(v) ? v : REDACTED]))
  );
}

/**
 * An MCP server as listed: the spec fields inline next to name, origin and users. A literal env or
 * header value (a hand-edited `mcp.yaml`) is never sent to the browser; saving the redacted text back
 * is refused by the server's reference check.
 */
export function toMcpDto(e: McpEntry): McpServerDto {
  const s = e.server as { env?: Record<string, string>; headers?: Record<string, string> };
  const env = redactMap(s.env);
  const headers = redactMap(s.headers);
  return {
    ...e.server,
    ...(env && { env }),
    ...(headers && { headers }),
    name: e.name,
    shipped: e.shipped,
    usedBy: e.usedBy,
  } as McpServerDto;
}

/** A skill as listed; the install time becomes epoch ms. */
export function toSkillDto(s: SkillEntry): SkillDto {
  const { installedAt, ...rest } = s;
  return { ...rest, ...(installedAt && { installedAt: Date.parse(installedAt) }) };
}
