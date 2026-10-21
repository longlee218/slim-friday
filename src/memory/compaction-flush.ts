import type { Database } from "bun:sqlite";
import { z } from "zod";
import { FLUSH_INPUT_MAX_CHARS, FLUSH_MAX_ITEMS } from "../config/memory-caps";
import { logEvent, logger } from "../observability/logger";
import { errText, redactText } from "../observability/redact";
import { FLUSH_SYSTEM } from "../roles/prompts/memory-prompts";
import { markFlushed, needsFlush } from "../storage/thread-summary-store";
import { appendJournalBlock, type JournalItem } from "./daily-journal";
import { type ChatText, type ExtractedContext, extractContext } from "./extract-context";
import { reindexFile } from "./index/memory-index";
import { safely } from "./index/safely";
import { isStructuredLesson } from "./lesson-format";
import type { CompactLlm } from "./memory-compaction-llm";
import { MEMORY_KINDS } from "./memory-sections";

/** What the PostCompact hook hands over: the thread, where its journal lives, the SDK summary and the chat tail captured by PreCompact. */
export interface FlushRequest {
  threadId: string;
  workspace: string;
  /** Channel (yaml name): the journal is per channel; none = nothing is written. */
  channel?: string;
  /** Compaction cycle this flush belongs to (read after `bumpCycle`): marks exactly this cycle, not a later one. */
  cycle: number;
  summary: string;
  tail: readonly ChatText[];
}

/** Collaborators of a flush (tests pass a fake `llm`, a temp `home` and a fixed clock). */
export interface FlushDeps {
  db: Database;
  home: string;
  llm: CompactLlm;
  now?: () => Date;
  /** Shutdown: aborts the model call; the flush then runs the keyword fallback. */
  signal?: AbortSignal;
}

/** Outcome of one flush: `skipped` = the cycle was already flushed; `none` = nothing durable or nothing written. */
export interface FlushResult {
  mode: "llm" | "fallback" | "none" | "skipped";
  items: number;
  saved: number;
}

const log = logger.child({ module: "compaction-flush" });

/** The model reply: a JSON object with a list of notes; each note is checked on its own (see `itemSchema`). */
const replySchema = z.object({ items: z.array(z.unknown()) });
/** One note: an unknown kind, empty text or a lesson without cue and evidence drops that note only. */
const itemSchema = z
  .object({ kind: z.enum(MEMORY_KINDS), text: z.string().min(1) })
  .refine((i) => i.kind !== "lesson" || isStructuredLesson(i.text));

/** The model input: summary then chat tail, both data, secrets masked BEFORE they leave the app; cut to its newest end. */
function flushInput(req: FlushRequest): string {
  const chat = req.tail.map((m) => `${m.role}: ${m.text}`).join("\n");
  const text = `Thread summary:\n${req.summary || "(none)"}\n\nNewest messages:\n${chat || "(none)"}`;
  return redactText(text).slice(-FLUSH_INPUT_MAX_CHARS);
}

/**
 * Parse the reply (plain JSON, or JSON inside a fence / text). Valid notes are kept, invalid ones dropped (counted).
 * null when it is not the expected shape, or when notes came but none is valid (the caller falls back).
 */
function parseReply(text: string): { items: JournalItem[]; dropped: number } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = replySchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    if (!parsed.success) return null;
    const valid: JournalItem[] = [];
    for (const raw of parsed.data.items) {
      const one = itemSchema.safeParse(raw);
      if (one.success) valid.push(one.data);
    }
    const dropped = parsed.data.items.length - valid.length;
    if (valid.length === 0 && dropped > 0) return null;
    return { items: valid.slice(0, FLUSH_MAX_ITEMS), dropped };
  } catch {
    return null; // not JSON
  }
}

/** Extract buckets -> journal items (keyword fallback). */
function itemsOf(e: ExtractedContext): JournalItem[] {
  return [
    ...e.decisions.map((text) => ({ kind: "decision" as const, text })),
    ...e.facts.map((text) => ({ kind: "fact" as const, text })),
    ...e.preferences.map((text) => ({ kind: "preference" as const, text })),
  ];
}

/**
 * Flush the notes of a just-compacted thread into its channel journal as one `## HH:MM Flush - thread <id6>` block.
 * Once per compaction cycle (`needsFlush`). One model call; a reply that is not the expected JSON, a model error or a
 * timeout falls back to the keyword extract over the tail (and summary). The writer redacts, makes lines single and
 * skips notes already in the day file. The request's cycle is marked flushed whatever the outcome, EXCEPT when the
 * journal lock timed out (`busy`): then it stays unflushed (retryable by a later flush; the next compaction's flush
 * marks its own cycle only). A full day file (`full`) or a symlink is logged at warn with counts and marked flushed:
 * retrying cannot succeed. A shutdown abort ends the model call and the keyword fallback runs. Logs
 * `memory.flush {workspace, channel, mode, items, saved, ms}` (counts only). Never throws.
 */
export async function flushAfterCompaction(d: FlushDeps, req: FlushRequest): Promise<FlushResult> {
  const t0 = Date.now();
  try {
    if (!needsFlush(d.db, req.threadId, req.cycle)) return { mode: "skipped", items: 0, saved: 0 };
    let mode: FlushResult["mode"] = "llm";
    let items: JournalItem[] | null = null;
    try {
      const reply = parseReply((await d.llm(FLUSH_SYSTEM, flushInput(req), d.signal)).text);
      items = reply?.items ?? null;
      if (!reply) logEvent(log, "memory.flush_bad_reply", {}, "warn");
      else if (reply.dropped)
        logEvent(
          log,
          "memory.flush_items_dropped",
          { dropped: reply.dropped, kept: items?.length },
          "warn",
        );
    } catch (err) {
      logEvent(log, "memory.flush_llm_failed", { err: errText(err, 200) }, "warn");
    }
    if (!items) {
      mode = "fallback";
      const chat: ChatText[] = [
        ...(req.summary ? [{ role: "assistant" as const, text: req.summary }] : []),
        ...req.tail,
      ];
      items = itemsOf(extractContext(chat));
    }
    let saved = 0;
    let busy = false;
    if (items.length === 0) mode = "none";
    else if (!req.channel)
      logEvent(log, "journal.skipped", { reason: "no_channel", notes: items.length });
    else {
      const res = appendJournalBlock({
        home: d.home,
        workspace: req.workspace,
        channel: req.channel,
        label: `Flush - thread ${req.threadId.slice(-6)}`,
        items,
        now: d.now?.() ?? new Date(),
      });
      saved = res.saved;
      busy = res.stopped === "busy";
      if (res.stopped && !busy)
        logEvent(
          log,
          "memory.flush_incomplete",
          { reason: res.stopped, items: items.length, saved },
          "warn",
        );
      if (saved) safely("reindex", () => reindexFile(d.db, d.home, res.file));
    }
    if (busy) logEvent(log, "memory.flush_busy", { items: items.length, saved }, "warn");
    else markFlushed(d.db, req.threadId, req.workspace, req.cycle, req.channel ?? "");
    logEvent(log, "memory.flush", {
      workspace: req.workspace,
      channel: req.channel ?? "",
      mode,
      items: items.length,
      saved,
      ms: Date.now() - t0,
    });
    return { mode, items: items.length, saved };
  } catch (err) {
    logEvent(log, "memory.flush_failed", { err: errText(err, 200) }, "warn");
    return { mode: "none", items: 0, saved: 0 };
  }
}
