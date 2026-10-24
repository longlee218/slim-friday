import type { BotDto, GroupDto } from "@friday/contracts";
import type { Bot, Group } from "@friday/core";

/** A bot as the web app sees it; explicit fields so engine-only ones (e.g. dirs) never leak. */
export function toBotDto(b: Bot): BotDto {
  return {
    id: b.id,
    name: b.name,
    title: b.title,
    instructions: b.instructions,
    model: b.model,
    tools: b.tools,
    skills: b.skills,
    subagents: b.subagents,
    workspaces: b.workspaces,
    ...(b.effort && { effort: b.effort }),
    ...(b.maxEffort && { maxEffort: b.maxEffort }),
    ...(b.autonomy && { autonomy: b.autonomy }),
    ...(b.avatar && { avatar: b.avatar }),
  };
}

/** A group as the web app sees it. */
export function toGroupDto(g: Group): GroupDto {
  return {
    id: g.id,
    name: g.name,
    members: g.members,
    entryBot: g.entryBot,
    workspaces: g.workspaces,
    instructions: g.instructions,
  };
}
