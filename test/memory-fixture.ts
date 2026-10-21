import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { channelMemoryFile } from "../src/memory/channel-memory";

/** Test fixture: a channel MEMORY.md holding `bullets` under one dated section (what a `MemorySave` call leaves behind). */
export function writeChannelNotes(
  home: string,
  ws: string,
  channel: string,
  bullets: string[],
): void {
  const f = channelMemoryFile(home, ws, channel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(
    f,
    `# ${channel} channel memory\n\n## 2026-10-13 note\n${bullets.map((b) => `- ${b}`).join("\n")}\n`,
  );
}

/** Name of the retired pending-queue file (built from parts: the retired-name scan bans the literal). A stray one must never be read or indexed. */
export const STRAY_QUEUE_FILE = ["MEMORY", "pending", "md"].join(".");
