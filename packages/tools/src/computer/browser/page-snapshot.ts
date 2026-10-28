/** One interactive element as the snapshot script reports it. */
export interface RawElement {
  i: number;
  role: string;
  name: string;
  value?: string;
}

/** What `PAGE_SNAPSHOT_SCRIPT` returns. */
export interface RawSnapshot {
  url: string;
  title: string;
  text: string;
  elements: RawElement[];
}

/** Most elements one snapshot lists. */
export const MAX_ELEMENTS = 80;
/** Visible text is cut at this many characters. */
export const MAX_TEXT_CHARS = 4000;
const MAX_VALUE_CHARS = 80;

/** Shown in place of a password field's value, which never reaches the bot. */
export const PASSWORD_MASK = "[hidden]";

/** Readable snapshot: refs `p<gen>:<i>`, at most 80 elements, text cut at 4 000 chars, password values masked. */
export function formatSnapshot(raw: RawSnapshot, gen: number): string {
  const shown = raw.elements.slice(0, MAX_ELEMENTS);
  const lines = shown.map((e) => {
    const value =
      e.role === "password"
        ? ` value=${PASSWORD_MASK}`
        : e.value
          ? ` value=${JSON.stringify(e.value.slice(0, MAX_VALUE_CHARS))}`
          : "";
    return `[p${gen}:${e.i}] ${e.role} ${JSON.stringify(e.name)}${value}`;
  });
  const text =
    raw.text.length > MAX_TEXT_CHARS
      ? `${raw.text.slice(0, MAX_TEXT_CHARS)}\n[text cut]`
      : raw.text;
  return [
    `url: ${raw.url}`,
    `title: ${raw.title}`,
    `elements (${shown.length} of ${raw.elements.length}):`,
    ...lines,
    "text:",
    text,
  ].join("\n");
}
