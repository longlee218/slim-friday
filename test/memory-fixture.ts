import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { repoMemoryFile } from "../src/memory/repo-memory";

/** Test fixture: a repo MEMORY.md holding `bullets` under one dated section (what a `Remember` call leaves behind). */
export function writeRepoNotes(home: string, ws: string, repo: string, bullets: string[]): void {
  const f = repoMemoryFile(home, ws, repo);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(
    f,
    `# ${repo} memory\n\n## 2026-10-13 note\n${bullets.map((b) => `- ${b}`).join("\n")}\n`,
  );
}
