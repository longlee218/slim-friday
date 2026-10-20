/**
 * Push every markdown heading of `text` down `by` levels (`#` becomes `###` for 2; capped at six `#`), so a block that
 * is injected under its own `## <name>` heading (a skill, a persona file, TEAM.md) nests below it and its sections are
 * not siblings of the blocks around it. Lines inside a fenced code block are left alone.
 */
export function demoteHeadings(text: string, by: number): string {
  let fence: string | undefined; // the opening fence marker while inside a code block
  return text
    .split("\n")
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line)?.[1];
      if (f && !fence) fence = f;
      else if (f && fence && f.startsWith(fence[0] as string) && f.length >= fence.length)
        fence = undefined;
      else if (!fence) {
        const m = /^(#{1,6})(\s.*)$/.exec(line);
        if (m) return `${"#".repeat(Math.min(6, (m[1] as string).length + by))}${m[2]}`;
      }
      return line;
    })
    .join("\n");
}
