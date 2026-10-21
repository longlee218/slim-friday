import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { cutMiddle } from "../memory/persona";
import { isSensitivePath } from "../runtime/sensitive-files";
import { demoteHeadings } from "../text/demote-headings";
import type { Location } from "./location-registry";

/** Max chars kept of one location rules file (cut 70/30 like a persona file). */
export const LOCATION_RULES_FILE_MAX = 8000;
/** Max files read per location (CLAUDE.md, its imports, then `.claude/rules` in path order). */
export const LOCATION_RULES_MAX_FILES = 10;
/** A CLAUDE.md line that imports a file, Claude Code style: `@DESIGN.md`. One level deep, markdown only. */
const IMPORT_LINE = /^@(\S+\.md)\s*$/gm;

/**
 * Real path of `rel` inside `root`, or undefined when it is missing, not a file, a sensitive file of the location
 * (`.env*`, `keys/`...), or resolves outside `root` (a symlink pointing at `~/.ssh` or AGENT_HOME is never read).
 */
function insideFile(root: string, rel: string): string | undefined {
  try {
    const file = realpathSync(join(root, rel));
    if (!file.startsWith(root + sep) || isSensitivePath(relative(root, file))) return undefined;
    if (!statSync(file).isFile()) return undefined;
    return file;
  } catch {
    return undefined;
  }
}

/** Every `.md` under `<root>/.claude/rules`, relative to root, sorted (subfolders included). */
function rulesFiles(root: string): string[] {
  const dir = join(root, ".claude", "rules");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".md"))
      .map((f) => relative(root, join(dir, f)))
      .sort();
  } catch {
    return [];
  }
}

/** The rule files of one location in prompt order: CLAUDE.md, the files it imports, then `.claude/rules`. */
function locationRuleFiles(root: string): { rel: string; body: string }[] {
  const out: { rel: string; body: string }[] = [];
  const seen = new Set<string>();
  const add = (rel: string): string | undefined => {
    const file = insideFile(root, rel);
    if (!file || seen.has(file) || out.length >= LOCATION_RULES_MAX_FILES) return undefined;
    seen.add(file);
    const body = readFileSync(file, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (body) out.push({ rel: relative(root, file), body });
    return body;
  };
  const claude = add("CLAUDE.md");
  for (const m of claude?.matchAll(IMPORT_LINE) ?? []) add(m[1] as string);
  for (const rel of rulesFiles(root)) add(rel);
  return out;
}

/**
 * Location rules block of a worker run: per location of its scope, the location's own CLAUDE.md (with its `@file.md`
 * imports) and `.claude/rules/*.md`, read by Friday (the SDK still loads no settings, hooks or skills of a repo).
 * One `## Location rules: <name>` section per location with rules, each file under `### <path>`, its headings pushed down.
 * "" when no location has a rule file.
 */
export function buildLocationRulesContext(locations: Location[]): string {
  const sections = locations.flatMap((l) => {
    let root: string;
    try {
      root = realpathSync(l.path);
    } catch {
      return [];
    }
    // A $HOME location: its CLAUDE.md and .claude/rules are the owner's global Claude Code files, not a repo's.
    if (root === realpathSync(homedir())) return [];
    const files = locationRuleFiles(root);
    if (files.length === 0) return [];
    const body = files
      .map(
        (f) =>
          `### ${f.rel}\n\n${demoteHeadings(cutMiddle(f.body, LOCATION_RULES_FILE_MAX, f.rel), 3)}`,
      )
      .join("\n\n");
    return [
      `## Location rules: ${l.name}\n\nThe rules of ${l.path}, from its own files. In this location they decide how code is written, structured and tested. Approval, delivery and reporting follow the Friday rules above.\n\n${body}`,
    ];
  });
  return sections.join("\n\n");
}
