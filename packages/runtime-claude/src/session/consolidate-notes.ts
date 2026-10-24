import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PromotedNote } from "@friday/core";
import { sdkEnv } from "../floor/sdk-env";
import { NOTE_CALL_TIMEOUT_MS, timeoutController } from "./call-timeout";
import {
  CONSOLIDATE_SYSTEM_PROMPT,
  consolidateUserPrompt,
  MAX_PROMOTED,
} from "./consolidate-notes-prompt";
import type { extractNotes } from "./extract-notes";

/** Longest prompt sent (memory + notes): a full journal day (about 60 000 chars) still leaves room for memory. */
const MAX_INPUT = 80000;

/** Kinds a promoted note may have (the MEMORY.md sections). */
const KINDS = new Set<string>(["decision", "fact", "preference", "lesson"]);

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
      const { kind, note, replaces } = (item ?? {}) as {
        kind?: unknown;
        note?: unknown;
        replaces?: unknown;
      };
      if (typeof kind !== "string" || !KINDS.has(kind)) continue;
      if (typeof note !== "string" || !note.trim()) continue;
      // Only a positive whole number names a memory note; anything else leaves a plain new note.
      const replacing = Number.isInteger(replaces) && (replaces as number) > 0;
      out.push({
        kind: kind as PromotedNote["kind"],
        note: note.trim(),
        ...(replacing && { replaces: replaces as number }),
      });
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
  input: { memory: string; notes: string[]; today?: string },
  opts: Parameters<typeof extractNotes>[1],
): Promise<PromotedNote[] | undefined> {
  const prompt = consolidateUserPrompt(input.memory, input.notes, input.today, MAX_INPUT);
  try {
    const run = (opts.queryFn ?? query)({
      prompt,
      options: {
        model: opts.model,
        systemPrompt: CONSOLIDATE_SYSTEM_PROMPT,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        abortController: timeoutController(opts.timeoutMs ?? NOTE_CALL_TIMEOUT_MS),
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
