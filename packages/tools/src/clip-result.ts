/** Longest text a tool result may carry to the model, in UTF-16 units. */
export const RESULT_MAX_CHARS = 12_000;

/**
 * Cut `text` to `max` chars and append a marker line saying how many chars were cut, so the model knows the
 * output is incomplete. The cut never splits a surrogate pair. Short text is returned unchanged.
 * NOTE: `packages/runtime-claude/src/session/post-tool-use-hook.ts` keeps a copy of this (same marker) because
 * runtime-claude may not import this package; keep them in step.
 */
export function clipResult(text: string, max = RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = max;
  // A high surrogate at the last kept unit would lose its low half: drop it too.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}\n…[output cut: ${text.length - cut} more characters not shown]`;
}
