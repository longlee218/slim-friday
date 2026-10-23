/* Sections of the plan text: the teammate writes the plan as markdown and a plan item names one of its headings. Pure. */

/** One markdown heading: its level (1-6) and text, and the index of its line. */
export interface PlanHeading {
  level: number;
  text: string;
  line: number;
}

/** `# Title`, `## Title ##`: level marks, a space, the text. */
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** A code fence line (``` or ~~~): a `#` inside it is not a heading. */
const FENCE = /^\s*(```|~~~)/;

/** Normalized form two heading texts are compared in. */
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** True when two heading texts are the same heading (case and spacing ignored). */
export const sameHeading = (a: string, b: string): boolean => norm(a) === norm(b);

/** Every heading of the markdown, in order; lines inside code fences are skipped. */
export function planHeadings(md: string): PlanHeading[] {
  const out: PlanHeading[] = [];
  let fenced = false;
  md.split("\n").forEach((raw, line) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    const m = fenced ? null : HEADING.exec(raw);
    if (m?.[1] && m[2]) out.push({ level: m[1].length, text: m[2].trim(), line });
  });
  return out;
}

/**
 * Text under the heading whose text equals `heading` (case and spacing ignored): from the line after it to the next
 * heading of the same or a higher level (deeper headings stay inside). Undefined when no heading matches.
 */
export function planSection(md: string, heading: string): string | undefined {
  const all = planHeadings(md);
  const at = all.findIndex((h) => sameHeading(h.text, heading));
  const start = all[at];
  if (!start) return undefined;
  const next = all.slice(at + 1).find((h) => h.level <= start.level);
  const lines = md.split("\n");
  return lines
    .slice(start.line + 1, next ? next.line : lines.length)
    .join("\n")
    .trim();
}
