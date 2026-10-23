/**
 * Split a file that starts with a `---` line, YAML, a second `---` line and a body.
 * Throws "missing front matter" when the header is absent or never closed.
 */
export function splitFrontMatter(text: string): { data: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") throw new Error("missing front matter");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw new Error("missing front matter");
  return {
    data: lines.slice(1, end).join("\n"),
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}
