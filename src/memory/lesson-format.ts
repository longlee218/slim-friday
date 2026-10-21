/* The one-line shape of a lesson note (Harness² style: a situation cue, the action, the evidence behind it). One line, so a
   lesson stays one bullet and its MemoryEdit id works like any other note. */

/** Parts of a lesson: when it applies, what to do, and what observed run supports it. */
export interface LessonParts {
  cue: string;
  lesson: string;
  evidence: string;
}

/** Marker between the action and its evidence. */
const EVIDENCE_MARK = " — evidence: ";

/** Shape check: `When <situation>: <action> — evidence: <source>` (each part non-empty). */
const STRUCTURED = /^When \S.*?: \S.* — evidence: \S/;

/** One line for the parts; a leading "When"/"when" in the cue is not doubled. */
export function formatLesson(p: LessonParts): string {
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const cue = one(p.cue).replace(/^when\s+/i, "");
  return `When ${cue}: ${one(p.lesson)}${EVIDENCE_MARK}${one(p.evidence)}`;
}

/** True when a lesson text has the cue, action and evidence parts. */
export function isStructuredLesson(text: string): boolean {
  return STRUCTURED.test(text.trim());
}

/** Text of the lesson form, for prompts (one source of truth). */
export const LESSON_FORM = `When <situation>: <action>${EVIDENCE_MARK}<source>`;
