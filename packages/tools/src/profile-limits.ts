/**
 * Caps of a bot's public profile on every write (`UpdateProfile`, `BotDesign` write_bot, the web settings). The
 * title is a trusted line of the bot's own system prompt, so a write keeps it short. The bot file parser loads
 * titles up to 200 chars, so an older, longer owner file still loads; it is refused only when changed to a longer one (an unchanged title still saves).
 */

/** Longest title a write accepts (characters). */
export const PROFILE_TITLE_MAX = 80;
/** Longest description a write accepts (characters; the parser applies the same cap). */
export const PROFILE_DESCRIPTION_MAX = 500;

/** A readable reason when a profile field breaks its write cap; undefined when it fits. */
export function profileLimitError(
  field: "title" | "description",
  value: string,
): string | undefined {
  const max = field === "title" ? PROFILE_TITLE_MAX : PROFILE_DESCRIPTION_MAX;
  return value.length > max
    ? `${field} has ${value.length} characters; at most ${max} are allowed.`
    : undefined;
}
