import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PostCompactHookInput,
  PreCompactHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { type ChatText, EXTRACT_SOURCE_CHARS } from "../memory/extract-context";
import { indexSummary } from "../memory/index/memory-index";
import { safely } from "../memory/index/safely";
import type { MemoryToolContext } from "../memory/memory-tool-context";
import { mergeSummary } from "../memory/summary-merge";
import { readTranscriptTail } from "../memory/transcript-tail";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { COMPACT_INSTRUCTIONS } from "../roles/prompts/memory-prompts";
import { bumpCycle, getThreadSummary, saveSummary } from "../storage/thread-summary-store";

const log = logger.child({ module: "compact-hooks" });
const CONTINUE = { continue: true } as const;

/** The memory context of a run that knows its thread (the role runner always sets it). */
export type CompactHookCtx = MemoryToolContext & { threadId: string };

/** One run's hooks and the chat tail PreCompact captured for the PostCompact of the same compaction. */
function makeHandlers(ctx: CompactHookCtx) {
  let tail: ChatText[] = [];

  /**
   * PreCompact (main agent, foreground runs): NO model call and no write (the hook blocks compaction). Keep the
   * newest chat text of the transcript in memory for the flush that PostCompact schedules. An unreadable
   * transcript leaves an empty tail (the hook guard logs it). Returns the what-to-keep text as `systemMessage`:
   * the SDK appends a callback hook's `systemMessage` to the compaction prompt as custom instructions, after any
   * `custom_instructions` of a manual /compact (it merges both itself, so those are not echoed here).
   */
  function onPreCompact(i: PreCompactHookInput): HookJSONOutput {
    try {
      tail = readTranscriptTail(i.transcript_path, EXTRACT_SOURCE_CHARS);
    } catch (err) {
      // An unreadable transcript must not drop the instructions below.
      tail = [];
      logEvent(log, "compact.hook_failed", { event: "PreCompact", err: errText(err, 200) }, "warn");
    }
    logEvent(log, "compact.pre", {
      trigger: i.trigger,
      chars: tail.reduce((n, m) => n + m.text.length, 0),
    });
    return { continue: true, systemMessage: COMPACT_INSTRUCTIONS };
  }

  /**
   * PostCompact (main agent, foreground runs only): count the cycle FIRST (even without a summary), store the SDK
   * summary merged with the previous one (`mergeSummary`) in the same transaction and index it, then hand the new
   * summary and the captured tail to `onCompacted` (the async memory flush). A missing summary keeps the old one and
   * the flush runs on the tail only.
   */
  function onPostCompact(i: PostCompactHookInput): void {
    const latest = typeof i.compact_summary === "string" ? i.compact_summary.trim() : "";
    ctx.db.transaction(() => {
      bumpCycle(ctx.db, ctx.threadId, ctx.workspace, ctx.channel ?? "");
      if (!latest) return;
      const previous = getThreadSummary(ctx.db, ctx.threadId)?.summary ?? "";
      saveSummary(ctx.db, {
        threadId: ctx.threadId,
        workspace: ctx.workspace,
        channel: ctx.channel ?? "",
        summary: mergeSummary(previous, latest),
        source: "compaction",
      });
    })();
    const row = getThreadSummary(ctx.db, ctx.threadId);
    if (!latest) logEvent(log, "compact.summary_missing", { trigger: i.trigger }, "warn");
    else if (row) safely("index summary", () => indexSummary(ctx.db, row));
    logEvent(log, "compact.post", {
      trigger: i.trigger,
      summaryChars: row?.summary.length ?? 0,
      cycle: row?.cycle,
    });
    const captured = tail;
    tail = [];
    ctx.onCompacted?.({
      threadId: ctx.threadId,
      workspace: ctx.workspace,
      channel: ctx.channel,
      cycle: row?.cycle ?? 0,
      summary: latest,
      tail: captured,
    });
  }

  return { onPreCompact, onPostCompact };
}

/** Hook callback for one event: subagent compactions are ignored; a throw is logged (class + clipped message), never propagated; compaction always continues (the run's output, if any, is returned). */
function guarded<T extends PreCompactHookInput | PostCompactHookInput>(
  event: T["hook_event_name"],
  // biome-ignore lint/suspicious/noConfusingVoidType: matches the SDK hook callbacks, which return void
  run: (i: T) => HookJSONOutput | void,
): HookCallback {
  return async (i) => {
    if (i.hook_event_name !== event) return CONTINUE;
    const input = i as T;
    try {
      if (input.agent_id) logEvent(log, "compact.subagent_ignored", { event });
      else return run(input) ?? CONTINUE;
    } catch (err) {
      logEvent(log, "compact.hook_failed", { event, err: errText(err, 200) }, "warn");
    }
    return CONTINUE;
  };
}

/**
 * Compaction hooks of one FOREGROUND run (`trackSummary`): PreCompact captures the chat tail, PostCompact stores the
 * thread summary and hands off the memory flush. Background runs (workers) register nothing: their compactions
 * write no memory. Best effort: neither hook blocks compaction or throws into the run; logs carry counts only.
 */
export function buildCompactHooks(
  ctx: CompactHookCtx,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!ctx.trackSummary) return {};
  const h = makeHandlers(ctx);
  return {
    PreCompact: [{ hooks: [guarded<PreCompactHookInput>("PreCompact", h.onPreCompact)] }],
    PostCompact: [{ hooks: [guarded<PostCompactHookInput>("PostCompact", h.onPostCompact)] }],
  };
}
