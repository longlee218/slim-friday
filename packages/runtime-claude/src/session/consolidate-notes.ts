import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PromotedNote } from "@friday/core";
import { sdkEnv } from "../floor/sdk-env";
import type { extractNotes } from "./extract-notes";

/** Longest prompt sent (memory + notes): a full journal day (about 60 000 chars) still leaves room for memory. */
const MAX_INPUT = 80000;
/** Most notes one consolidation promotes. */
const MAX_PROMOTED = 5;
/** A consolidation call that has not answered by then is given up (the mark stays). */
const CALL_TIMEOUT_MS = 120_000;

/** An abort controller that fires after `ms` (the timer does not keep the process alive). */
function timeoutController(ms: number): AbortController {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms).unref?.();
  return ac;
}

/** Kinds a promoted note may have (the MEMORY.md sections). */
const KINDS = new Set<string>(["decision", "fact", "preference", "lesson"]);

const SYSTEM_PROMPT =
  "You keep the long-term memory of an assistant bot. You get its current MEMORY.md and numbered notes from its " +
  "recent journal. MEMORY.md is read at the start of every conversation, so each line costs attention: the " +
  "default answer is []. Promote a note only if it will still be true in a month and would change a future " +
  "answer or action: a standing rule or preference, a decision with its reason, a stable fact, a lesson from a " +
  "mistake. Skip a note that is a one-off event, task progress or status, a detail readable from the code, a " +
  "guess, or already in memory even in other words. Merge notes that say the same thing into one. Rewrite each " +
  `kept note as one line under 200 characters that makes sense alone. At most ${MAX_PROMOTED}. Answer with a JSON ` +
  'array only: [{"kind": "decision" | "fact" | "preference" | "lesson", "note": "..."}].';

/** The first JSON array in `text` as promoted notes; bad items are dropped; undefined when there is no array. */
function parsePromoted(text: string): PromotedNote[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return undefined;
    const out: PromotedNote[] = [];
    for (const item of parsed) {
      const { kind, note } = (item ?? {}) as { kind?: unknown; note?: unknown };
      if (typeof kind !== "string" || !KINDS.has(kind)) continue;
      if (typeof note !== "string" || !note.trim()) continue;
      out.push({ kind: kind as PromotedNote["kind"], note: note.trim() });
    }
    return out.slice(0, MAX_PROMOTED);
  } catch {
    return undefined;
  }
}

/**
 * Journal notes worth promoting into MEMORY.md: one tool-less, one-turn model call. Never throws; a failed call or
 * an answer without a JSON array gives undefined (the caller then keeps its mark), `[]` means nothing to keep.
 */
export async function consolidateNotes(
  input: { memory: string; notes: string[] },
  opts: Parameters<typeof extractNotes>[1],
): Promise<PromotedNote[] | undefined> {
  // The notes are sent whole (the caller caps them); only the memory, context for the model, is cut to fit.
  const notes = `<notes>\n${input.notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n</notes>`;
  const room = Math.max(0, MAX_INPUT - notes.length - "<memory>\n\n</memory>\n\n".length);
  const prompt = `<memory>\n${input.memory.slice(0, room)}\n</memory>\n\n${notes}`;
  try {
    const run = (opts.queryFn ?? query)({
      prompt,
      options: {
        model: opts.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        abortController: timeoutController(CALL_TIMEOUT_MS),
        env: sdkEnv(
          { hasRealAuth: !!opts.oauthToken, oauthToken: opts.oauthToken },
          opts.env ?? {},
          {
            oneShot: true,
          },
        ),
      },
    });
    for await (const m of run)
      if (m.type === "result") return m.subtype === "success" ? parsePromoted(m.result) : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}
