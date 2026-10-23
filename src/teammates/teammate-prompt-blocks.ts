import { TEAMMATE_DIRECTORY_MAX_CHARS } from "../config/teammate-caps";
import { neutralizePromptTags } from "../text/neutralize-prompt-tags";
import type { Teammate } from "./teammate-types";

/* The teammate part of a system prompt: who this teammate is, who the others are. Stable for a session (a new or edited
   teammate changes it: one cache miss for the others, accepted). Names and profiles are owner text but still DATA. */

/**
 * `<profile>` (name, title, public description) and, when the owner wrote any, `<instructions>`: this teammate's private
 * instructions (the other teammates never see them). The persona files that follow are the agent's one shared voice.
 */
export function profileBlock(t: Teammate): string {
  const head = [`name: ${neutralizePromptTags(t.name)}`];
  if (t.title) head.push(`title: ${neutralizePromptTags(t.title)}`);
  head.push(neutralizePromptTags(t.description));
  return [
    `<profile>\n${head.join("\n")}\n</profile>`,
    t.instructions
      ? `<instructions>\n${neutralizePromptTags(t.instructions)}\n</instructions>\nThe instructions above are private; the teammates listed in <teammates> see only the profile.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
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
