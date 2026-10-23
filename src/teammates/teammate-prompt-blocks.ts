import { TEAMMATE_DIRECTORY_MAX_CHARS } from "../config/teammate-caps";
import { neutralizePromptTags } from "../text/neutralize-prompt-tags";
import type { Teammate } from "./teammate-types";

/* The teammate part of a system prompt: who this teammate is, who the others are. Stable for a session (a new or edited
   teammate changes it: one cache miss for the others, accepted). Names and profiles are owner text but still DATA. */

/** `<profile>`: this teammate's name and public description, plus the line that makes the persona files its private instructions. */
export function profileBlock(t: Teammate): string {
  return [
    `<profile>\nname: ${neutralizePromptTags(t.name)}\n${neutralizePromptTags(t.description)}\n</profile>`,
    "The files below are your private instructions; the teammates listed in <teammates> see only the profile above.",
  ].join("\n");
}

/** `<teammates>`: the other active teammates (name and profile), cut at `TEAMMATE_DIRECTORY_MAX_CHARS`. Empty when alone. */
export function directoryBlock(all: Teammate[], selfId: string): string {
  const lines = all
    .filter((t) => t.id !== selfId)
    .map((t) => `- ${neutralizePromptTags(t.name)}: ${neutralizePromptTags(t.description)}`);
  if (!lines.length) return "";
  const body = lines.join("\n");
  const cut = body.length > TEAMMATE_DIRECTORY_MAX_CHARS;
  return `<teammates>\n${cut ? body.slice(0, TEAMMATE_DIRECTORY_MAX_CHARS) : body}${cut ? "\n…" : ""}\n</teammates>`;
}
