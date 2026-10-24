/**
 * Cut `text` into chunks of at most `max` chars (Discord's message limit). Each cut is at the last line break
 * inside the window, else the last space, else hard at `max`; the cut separator is dropped. Never returns an
 * empty chunk.
 */
export function splitText(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n");
    if (cut <= 0) cut = window.lastIndexOf(" ");
    if (cut <= 0) {
      chunks.push(window);
      rest = rest.slice(max);
    } else {
      chunks.push(window.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
  }
  chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}
