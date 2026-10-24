import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectRules } from "@friday/core";

/** Rules files looked up in a workspace root, in priority order. */
const RULES_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/** Longest rules text passed on, in characters (including the trailing ellipsis). */
const MAX_CHARS = 8_000;

/**
 * Reads the first of CLAUDE.md / AGENTS.md that is a regular file in `workspace`.
 * Cheap on purpose (lstat + readFile): it runs on every group turn. A symlink is
 * skipped (lstat, not stat). The text is untrusted repo content: only trimmed and cut here.
 */
export async function readProjectRules(workspace: string): Promise<ProjectRules | undefined> {
  for (const file of RULES_FILES) {
    const path = join(workspace, file);
    try {
      if (!(await lstat(path)).isFile()) continue;
      const text = (await readFile(path, "utf8")).trim();
      return { file, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text };
    } catch {
      // Missing or unreadable file: try the next one.
    }
  }
  return undefined;
}
