/**
 * Dates and times of memory files and bullets: the LOCAL time of the machine running the bot (owner decision,
 * no config). Callers read the clock ONCE and pass the Date, so a file name and the bullets inside agree.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar day, `YYYY-MM-DD`. */
export const localDay = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/** Local time of day, `HH:MM`. */
export const localHhmm = (now: Date = new Date()): string =>
  `${pad(now.getHours())}:${pad(now.getMinutes())}`;
