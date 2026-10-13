import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PostCompactHookInput,
  PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { appendJournalBlock, type JournalItem } from "../memory/daily-journal";
import {
  EXTRACT_SOURCE_CHARS,
  type ExtractedContext,
  extractContext,
  extractSize,
} from "../memory/extract-context";
import { indexSummary, reindexFile } from "../memory/index/memory-index";
import { safely } from "../memory/index/safely";
import { mergeSummary } from "../memory/summary-merge";
import { readTranscriptTail } from "../memory/transcript-tail";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { bumpCycle, getThreadSummary, saveSummary } from "../storage/thread-summary-store";
import type { MemoryToolContext } from "../tools/memory-tool-context";

/** Journal block titles; the thread label is appended (the writer cuts the whole label to one short line). */
const EXTRACT_LABEL = "Extracted Context";
/** Max chars of the thread label inside a block title. */
const LABEL_THREAD_CHARS = 30;

const log = logger.child({ module: "compact-hooks" });
const CONTINUE = { continue: true } as const;

/** The memory context of a run that knows its thread (the role runner always sets it). */
export type CompactHookCtx = MemoryToolContext & { threadId: string };

/** Extract buckets -> journal items (`###` Decisions / Facts / Preferences of the P4 format). */
function itemsOf(e: ExtractedContext): JournalItem[] {
  return [
    ...e.decisions.map((text) => ({ kind: "decision" as const, text })),
    ...e.facts.map((text) => ({ kind: "fact" as const, text })),
    ...e.preferences.map((text) => ({ kind: "preference" as const, text })),
  ];
}

const label = (ctx: CompactHookCtx, title: string): string =>
  `${title} - ${ctx.threadLabel.slice(0, LABEL_THREAD_CHARS)}`;

/**
 * PreCompact (main agent only): NO model call (the hook blocks compaction; a model call here would be slow and
 * start a second session). Read the newest chat text of the transcript, pick decisions / facts / owner
 * preferences by keyword, append them to today's journal as `## HH:MM Extracted Context - <thread>`, mark the
 * (the cycle is NOT marked flushed: the keyword extract is a safety net, the real flush is the rollover's). An unreadable transcript writes nothing.
 */
function onPreCompact(ctx: CompactHookCtx, i: PreCompactHookInput): void {
  const extract = extractContext(readTranscriptTail(i.transcript_path, EXTRACT_SOURCE_CHARS));
  const now = ctx.now?.() ?? new Date();
  let saved = 0;
  if (extractSize(extract) > 0) {
    const res = appendJournalBlock({
      home: ctx.home,
      workspace: ctx.workspace,
      label: label(ctx, EXTRACT_LABEL),
      items: itemsOf(extract),
      now,
    });
    saved = res.saved;
    if (saved) safely("reindex", () => reindexFile(ctx.db, ctx.home, res.file));
  }
  logEvent(log, "compact.pre", {
    trigger: i.trigger,
    decisions: extract.decisions.length,
    facts: extract.facts.length,
    preferences: extract.preferences.length,
    saved,
  });
}

/**
 * PostCompact (main agent, foreground runs only): count the cycle FIRST (even without a summary), then store
 * the SDK summary merged with the previous one (`mergeSummary`) in the same transaction and index it.
 * A missing summary keeps the old one.
 */
function onPostCompact(ctx: CompactHookCtx, i: PostCompactHookInput): void {
  const latest = typeof i.compact_summary === "string" ? i.compact_summary.trim() : "";
  if (!latest) {
    bumpCycle(ctx.db, ctx.threadId, ctx.workspace);
    logEvent(log, "compact.summary_missing", { trigger: i.trigger }, "warn");
    return;
  }
  ctx.db.transaction(() => {
    bumpCycle(ctx.db, ctx.threadId, ctx.workspace);
    const previous = getThreadSummary(ctx.db, ctx.threadId)?.summary ?? "";
    saveSummary(ctx.db, ctx.threadId, ctx.workspace, mergeSummary(previous, latest));
  })();
  const row = getThreadSummary(ctx.db, ctx.threadId);
  if (row) safely("index summary", () => indexSummary(ctx.db, row));
  logEvent(log, "compact.post", {
    trigger: i.trigger,
    summaryChars: row?.summary.length ?? 0,
    cycle: row?.cycle,
  });
}

/** Hook callback for one event: subagent compactions are ignored; a throw is logged (class + clipped message), never propagated; compaction always continues. */
function guarded<T extends PreCompactHookInput | PostCompactHookInput>(
  event: T["hook_event_name"],
  run: (i: T) => void,
): HookCallback {
  return async (i) => {
    if (i.hook_event_name !== event) return CONTINUE;
    const input = i as T;
    try {
      if (input.agent_id) logEvent(log, "compact.subagent_ignored", { event });
      else run(input);
    } catch (err) {
      logEvent(log, "compact.hook_failed", { event, err: errText(err, 200) }, "warn");
    }
    return CONTINUE;
  };
}

/**
 * Compaction hooks of one run (every role): PreCompact journals an extractive block, PostCompact stores the
 * thread summary. Best effort: neither blocks compaction nor throws into the run; logs carry counts only.
 */
export function buildCompactHooks(
  ctx: CompactHookCtx,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreCompact: [
      { hooks: [guarded<PreCompactHookInput>("PreCompact", (i) => onPreCompact(ctx, i))] },
    ],
    // Background runs (dev) never touch the thread summary or its cycle counters.
    ...(ctx.trackSummary && {
      PostCompact: [
        { hooks: [guarded<PostCompactHookInput>("PostCompact", (i) => onPostCompact(ctx, i))] },
      ],
    }),
  };
}
