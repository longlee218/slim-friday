/** Short id agents see and cite for a stored message: `M<id>`. */
export const messageRef = (id: number): string => `M${id}`;

/** Message id from `M42`, `m42` or `42`; undefined for anything else (or an id below 1). */
export function parseMessageRef(ref: string): number | undefined {
  const m = /^[Mm]?(\d{1,15})$/.exec(ref.trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : undefined;
}
