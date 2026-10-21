import { z } from "zod";
import { DREAM_NOTES_MAX_CHARS } from "../config/memory-caps";
import { redactText } from "../observability/redact";
import type { DreamItem } from "./dream-inputs";
import { datedBullets } from "./dream-sections";
import { SAVE_MAX_CHARS } from "./memory-limits";
import {
  formatBullet,
  KIND_HEADING,
  MEMORY_FILE_KINDS,
  type MemoryKind,
  normalizeBullet,
  stripDateSuffix,
} from "./memory-sections";
import { sanitizeBullet } from "./sanitize-bullet";

/* Model side of dreaming: the prompt text, the reply parsing and the sanitized bullets built from the reply. */

/** Kinds a MEMORY.md holds. */
export type FileKind = Exclude<MemoryKind, "open">;

/** `MEMORY_FILE_KINDS` with its precise type. */
export const FILE_KINDS = MEMORY_FILE_KINDS as readonly FileKind[];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reply key of each kind (the JSON object the model returns). */
const REPLY_KEY: Record<FileKind, "decisions" | "facts" | "preferences" | "lessons"> = {
  decision: "decisions",
  fact: "facts",
  preference: "preferences",
  lesson: "lessons",
};

const note = z.object({ text: z.string(), date: z.string().optional() });
/** The model's reply: the full new set of dated notes per kind. All four lists are required (a missing one = bad reply). */
const replySchema = z.object({
  decisions: z.array(note),
  facts: z.array(note),
  preferences: z.array(note),
  lessons: z.array(note),
});

/** What `buildPrompt` returns: the text, the notes the model sees (`sent`) and how many existing notes were left out. */
export interface DreamPrompt {
  prompt: string;
  sent: string[];
  total: number;
}

/** Date of a dated bullet line (`... (YYYY-MM-DD)`), the sort key of the notes cap. */
const dateOf = (bullet: string): string => bullet.slice(-11, -1);

/**
 * Model input: the current dated notes per section (numbered), then the items (redacted: secrets never leave the
 * process). Notes over `DREAM_NOTES_MAX_CHARS`: the newest (date, then later in the file) within the cap are sent.
 */
export function buildPrompt(text: string, items: DreamItem[]): DreamPrompt {
  const all = MEMORY_FILE_KINDS.flatMap((k) =>
    datedBullets(text, k).map((bullet, pos) => ({ k, bullet, pos })),
  );
  const keep = new Set<(typeof all)[number]>();
  let size = 0;
  for (const n of [...all].sort(
    (a, b) => dateOf(b.bullet).localeCompare(dateOf(a.bullet)) || b.pos - a.pos,
  )) {
    if (size + n.bullet.length + 1 > DREAM_NOTES_MAX_CHARS) continue;
    size += n.bullet.length + 1;
    keep.add(n);
  }
  const current = MEMORY_FILE_KINDS.map((k) => {
    const list = all
      .filter((n) => n.k === k && keep.has(n))
      .map((n, i) => `${i + 1}. ${n.bullet.slice(2)}`);
    return `## ${KIND_HEADING[k]}\n${list.length ? list.join("\n") : "(none)"}`;
  }).join("\n\n");
  const news = items.map((it, i) => `### Item ${i + 1}\n${redactText(it.text)}`).join("\n\n");
  return {
    prompt: `Current notes:\n\n${current}\n\nNew items:\n\n${news}`,
    sent: all.filter((n) => keep.has(n)).map((n) => n.bullet),
    total: all.length,
  };
}

/** Parse the reply: the first JSON object of the text, zod-checked. Null when unusable. */
export function parseReply(raw: string): z.infer<typeof replySchema> | null {
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const r = replySchema.safeParse(JSON.parse(raw.slice(a, b + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * New dated bullets per kind from the reply: every text goes through `sanitizeBullet` (secrets masked, one line, at most
 * `SAVE_MAX_CHARS`), the date is checked (else `fallbackDate`), duplicates by normalized text are dropped.
 */
export function bulletsOf(
  reply: z.infer<typeof replySchema>,
  fallbackDate: string,
): Record<FileKind, string[]> {
  const seen = new Set<string>();
  const out = {} as Record<FileKind, string[]>;
  for (const k of FILE_KINDS) {
    out[k] = [];
    for (const n of reply[REPLY_KEY[k]]) {
      const clean = stripDateSuffix(sanitizeBullet(n.text, SAVE_MAX_CHARS));
      const key = normalizeBullet(clean);
      if (!clean || !key || seen.has(key)) continue;
      seen.add(key);
      out[k].push(formatBullet(clean, n.date && DATE.test(n.date) ? n.date : fallbackDate));
    }
  }
  return out;
}
