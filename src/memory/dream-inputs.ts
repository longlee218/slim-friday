import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DREAM_ITEM_MAX_CHARS, JOURNAL_RETENTION_DAYS } from "../config/memory-caps";
import { workspacePaths } from "../config/workspace-paths";
import { type UnpromotedEpisode, unpromotedEpisodes } from "../storage/episode-store";
import { promotedHashes } from "../storage/memory-promotion-store";
import { localDay } from "./memory-clock";
import { normalizeBullet } from "./memory-sections";

/** One thing dreaming may consume: an episode or a block of a journal day file with bullets not consumed yet. */
export interface DreamItem {
  /** Time of the source (epoch ms), the sort key: oldest first. */
  at: number;
  /** Local day `YYYY-MM-DD` of the source (the fallback date of a bullet the model leaves undated). */
  date: string;
  /** Text shown to the model, already clipped to `DREAM_ITEM_MAX_CHARS`. */
  text: string;
  /** Set for an episode: the version to mark promoted. */
  episode?: UnpromotedEpisode;
  /** Set for a journal block: hashes of the bullets shown (the ones to put in the ledger). */
  hashes?: string[];
}

/** Ledger key of a journal bullet: first 16 hex chars of sha1 over its normalized text (date and markup out). */
export const bulletHash = (bullet: string): string =>
  createHash("sha1").update(normalizeBullet(bullet)).digest("hex").slice(0, 16);

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const BLOCK_HEAD = /^## (\d{2}):(\d{2}) (.*)$/;
const KIND_HEAD = /^### (.+)$/;

/** Local midnight of a `YYYY-MM-DD` day plus `hh:mm`, epoch ms. */
const atOf = (day: string, hh: number, mm: number): number => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hh, mm).getTime();
};

/**
 * Items of one journal day file: one per `## HH:MM <label>` block that still has bullets whose hash is not in the
 * ledger. The text lists those bullets as `[Kind] text`, cut at `DREAM_ITEM_MAX_CHARS` (a bullet that does not fit
 * is left out, so its hash is not marked and it is used by a later dream).
 */
function blocksOf(day: string, text: string, done: Set<string>): DreamItem[] {
  const items: DreamItem[] = [];
  let cur: { at: number; head: string; lines: string[]; hashes: string[]; size: number } | null =
    null;
  let kind = "";
  const flush = () => {
    if (cur?.hashes.length)
      items.push({
        at: cur.at,
        date: day,
        text: [cur.head, ...cur.lines].join("\n"),
        hashes: cur.hashes,
      });
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const head = BLOCK_HEAD.exec(line);
    if (head) {
      flush();
      const label = head[3] ?? "";
      const h = `Journal ${day} ${head[1]}:${head[2]} ${label}`;
      cur = {
        at: atOf(day, Number(head[1]), Number(head[2])),
        head: h,
        lines: [],
        hashes: [],
        size: h.length,
      };
      kind = "";
      continue;
    }
    if (!cur) continue;
    const k = KIND_HEAD.exec(line);
    if (k) kind = k[1] ?? "";
    else if (line.startsWith("- ")) {
      const hash = bulletHash(line);
      const shown = `- [${kind || "Note"}] ${line.slice(2)}`;
      if (done.has(hash) || cur.hashes.includes(hash)) continue;
      if (cur.size + shown.length + 1 > DREAM_ITEM_MAX_CHARS) continue;
      cur.lines.push(shown);
      cur.hashes.push(hash);
      cur.size += shown.length + 1;
    }
  }
  flush();
  return items;
}

/**
 * All items of a channel that no dream used yet, oldest first: unpromoted episodes (clipped to `DREAM_ITEM_MAX_CHARS`)
 * and journal blocks of the last `JOURNAL_RETENTION_DAYS` days. A missing journal dir is simply no items.
 */
export function collectDreamItems(
  db: Database,
  home: string,
  workspace: string,
  channel: string,
  now: Date,
): DreamItem[] {
  const items: DreamItem[] = unpromotedEpisodes(db, workspace, channel).map((e) => ({
    at: e.updatedAt,
    date: localDay(new Date(e.updatedAt)),
    text: `Episode ${localDay(new Date(e.updatedAt))}:\n${e.summary.slice(0, DREAM_ITEM_MAX_CHARS)}`,
    episode: e,
  }));
  const dir = workspacePaths(home).workspace(workspace).channel(channel).journalDir;
  const oldest = localDay(new Date(now.getTime() - JOURNAL_RETENTION_DAYS * 86_400_000));
  let files: string[] = [];
  try {
    files = readdirSync(dir).sort();
  } catch {
    /* no journal yet */
  }
  const done = promotedHashes(db, workspace, channel);
  for (const f of files) {
    const day = DAY_FILE.exec(f)?.[1];
    if (!day || day < oldest) continue;
    try {
      items.push(...blocksOf(day, readFileSync(`${dir}/${f}`, "utf8"), done));
    } catch {
      /* unreadable day file: skipped this time */
    }
  }
  return items.sort((a, b) => a.at - b.at);
}
