/**
 * Tag names that mark the teammate prompt's data boundaries (system prompt: owner files, team, profile, teammates; user turn: memory, goal
 * state, events, owner message).
 */
const PROMPT_TAGS =
  "owner_files|file|team|profile|teammates|memory|goal_state|events|owner_message";

/** An opening or closing prompt tag, any case. */
const TAG_RE = new RegExp(`<(/?)(${PROMPT_TAGS})\\b`, "gi");

/**
 * Data text placed inside a prompt tag with any of the reserved tags made inert (`<events>` -> `‹events>`), so a
 * worker result, an excerpt or a memory note cannot close its block and fake an `<owner_message>`.
 */
export const neutralizePromptTags = (text: string): string => text.replace(TAG_RE, "‹$1$2");
