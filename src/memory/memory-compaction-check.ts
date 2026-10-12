import type { CompactedGroup } from "./memory-compaction-prompt";
import { nonDerivable, sourcesOf } from "./memory-derivability";
import { MEMORY_SECTION_HEADINGS, stripDateSuffix } from "./memory-sections";

/** Trailing `(YYYY-MM-DD)` of a bullet, or "". */
const dateOf = (bullet: string): string => /\((\d{4}-\d{2}-\d{2})\)$/.exec(bullet)?.[1] ?? "";

/** Input bullets by kind heading; `loose` = bullets outside every kind section (legacy / owner text). */
export interface InputGroups {
  byHeading: Map<string, string[]>;
  loose: string[];
  /** True when the input has at least one kind heading. */
  hasKind: boolean;
}

/** Split the old file's bullets by the exact kind heading they sit under. */
export function inputGroups(raw: string): InputGroups {
  const byHeading = new Map<string, string[]>();
  const loose: string[] = [];
  let cur: string | null = null;
  for (const line of raw.split("\n").map((l) => l.trim())) {
    if (line.startsWith("#")) {
      const h = MEMORY_SECTION_HEADINGS.find((x) => line === `## ${x}`);
      cur = h ?? null;
      if (h && !byHeading.has(h)) byHeading.set(h, []);
    } else if (line.startsWith("- ")) {
      if (cur) byHeading.get(cur)?.push(line);
      else loose.push(line);
    }
  }
  return { byHeading, loose, hasKind: byHeading.size > 0 };
}

/**
 * Output bullets of one pool that are not derivable from the pool's input bullets: invented text (see
 * `nonDerivable`, compared without the date stamp) or a date stamp that no source bullet of the text carries
 * (a model must not invent or refresh dates).
 */
export function poolOffenders(input: string[], output: string[]): string[] {
  const inText = input.map(stripDateSuffix);
  const bad = new Set(nonDerivable(inText, output.map(stripDateSuffix)));
  return output.filter((o) => {
    const text = stripDateSuffix(o);
    if (bad.has(text)) return true;
    const d = dateOf(o);
    return d !== "" && !sourcesOf(inText, text).some((i) => dateOf(input[i] ?? "") === d);
  });
}

/**
 * Check a parsed model output against the old file. Flat output: one pool. Grouped output: a bullet under
 * heading H must derive from the input bullets of H plus the loose ones; loose output bullets from loose only.
 * Returns the offending bullets (empty = fine).
 */
export function compactionOffenders(
  raw: string,
  bullets: string[],
  groups: CompactedGroup[] | undefined,
  allInput: string[],
): string[] {
  if (!groups) return poolOffenders(allInput, bullets);
  const inp = inputGroups(raw);
  return groups.flatMap((g) =>
    poolOffenders(
      g.heading ? [...(inp.byHeading.get(g.heading) ?? []), ...inp.loose] : inp.loose,
      g.bullets,
    ),
  );
}
