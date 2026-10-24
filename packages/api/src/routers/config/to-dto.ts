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
    ...(b.effort && { effort: b.effort }),
    ...(b.maxEffort && { maxEffort: b.maxEffort }),
    ...(b.autonomy && { autonomy: b.autonomy }),
    ...(b.avatar && { avatar: b.avatar }),
    ...(avatarUrl && { avatarUrl }),
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

/** An MCP server as listed: the spec fields inline next to name, origin and users. */
export function toMcpDto(e: McpEntry): McpServerDto {
  return { ...e.server, name: e.name, shipped: e.shipped, usedBy: e.usedBy } as McpServerDto;
}

/** A skill as listed; the install time becomes epoch ms. */
export function toSkillDto(s: SkillEntry): SkillDto {
  const { installedAt, ...rest } = s;
  return { ...rest, ...(installedAt && { installedAt: Date.parse(installedAt) }) };
}
