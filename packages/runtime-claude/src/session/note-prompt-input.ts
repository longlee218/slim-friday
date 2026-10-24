/** The first line of a note call's message: today's date, when the caller gave it. */
export const todayLine = (today?: string): string => (today ? `Today: ${today}\n\n` : "");

/** Input text with the closing tags of the note prompts escaped, so it cannot end the block it sits in. */
export const escapeBlock = (text: string): string =>
  text.replace(/<\s*\/\s*(summary|transcript|memory|notes)\s*>/gi, "<\\/$1>");
