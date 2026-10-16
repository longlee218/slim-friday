import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { locationMemoryFile } from "../src/memory/location-memory";

/** Test fixture: a location MEMORY.md holding `bullets` under one dated section (what a `MemorySave` call leaves behind). */
export function writeLocationNotes(
  home: string,
  ws: string,
  location: string,
  bullets: string[],
): void {
  const f = locationMemoryFile(home, ws, location);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(
    f,
    `# ${location} memory\n\n## 2026-10-13 note\n${bullets.map((b) => `- ${b}`).join("\n")}\n`,
  );
}
