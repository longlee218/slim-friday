/* Discord markdown hint styles for code-rendered messages (digest, alert, approval, report summary). */

/** Small grey meta line (source, time, ids): Discord subtext. */
export const subtext = (text: string): string => `-# ${text}`;

/** One-line summary or take-note: italic. Newlines would break the markers, so they fold to spaces. */
export const note = (text: string): string =>
  `*${text.replace(/\s*\n\s*/g, " ").replace(/\*/g, "")}*`;

/** Cited text: every line quoted. */
export const quote = (text: string): string =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
