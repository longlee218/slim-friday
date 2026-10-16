import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { ChatText } from "./extract-context";

/** Bytes read from the end of a transcript file (the file can be megabytes; only the newest part matters). */
const TRANSCRIPT_TAIL_BYTES = 262_144;

/** Text injected by the harness, not said by anyone (system reminders, slash-command echoes, task notices). */
const INJECTED = /^\s*<(?:system-reminder|command-|local-command|task-notification)/;

/** Text blocks of one transcript entry's `message.content` (a string, or blocks: only `text` ones count). */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) =>
    b && typeof b === "object" && (b as { type?: unknown }).type === "text"
      ? [String((b as { text?: unknown }).text ?? "")]
      : [],
  );
}

/** Plain user/assistant text of one JSONL line, or []. Sidechain (subagent), meta and compact-summary entries are skipped. */
function parseLine(line: string): ChatText[] {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return []; // a torn or foreign line
  }
  const role = e.type;
  if ((role !== "user" && role !== "assistant") || e.isSidechain || e.isMeta || e.isCompactSummary)
    return [];
  const msg = e.message as { content?: unknown } | undefined;
  return textsOf(msg?.content)
    .filter((t) => t.trim() && !INJECTED.test(t))
    .map((text) => ({ role, text }));
}

/**
 * Newest chat text of a Claude transcript (JSONL), at most `maxChars` chars, oldest first. Reads only the last
 * `TRANSCRIPT_TAIL_BYTES` bytes. Tool calls and tool results are excluded. THROWS when the path is not a
 * readable regular file (the caller logs and moves on).
 */
export function readTranscriptTail(path: string, maxChars: number): ChatText[] {
  if (!lstatSync(path).isFile()) throw new Error("transcript is not a regular file");
  const fd = openSync(path, "r");
  let raw: string;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    raw = buf.toString("utf8");
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1); // the first line is cut in the middle
  } finally {
    closeSync(fd);
  }
  const all = raw.split("\n").flatMap(parseLine);
  // Keep the newest messages whose total fits; the oldest kept one may be cut at its start.
  const kept: ChatText[] = [];
  let left = maxChars;
  for (let i = all.length - 1; i >= 0 && left > 0; i--) {
    const m = all[i] as ChatText;
    kept.unshift(m.text.length > left ? { ...m, text: m.text.slice(-left) } : m);
    left -= m.text.length;
  }
  return kept;
}
