import { SUBJECT_MAX_CHARS } from "../config/lead-caps";

/** Subject of a task that was given none (code-made verify / fix / planner items, rows and plans older than `subject`): the first words of its brief, one line, at most `SUBJECT_MAX_CHARS`. */
export const subjectFromBrief = (brief: string): string =>
  brief.replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX_CHARS);
