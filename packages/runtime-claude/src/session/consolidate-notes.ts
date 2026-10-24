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
import { jsonSchemaOutput, PromotedNotes, STRUCTURED_MAX_TURNS } from "./note-output-schema";

/** Longest prompt sent (memory + notes): a full journal day (about 60 000 chars) still leaves room for memory. */
const MAX_INPUT = 80000;

/** The structured answer as promoted notes, trimmed, empty ones dropped; undefined when it has the wrong shape. */
function parsePromoted(output: unknown): PromotedNote[] | undefined {
  const answer = PromotedNotes.safeParse(output);
  if (!answer.success) return undefined;
  return answer.data.notes
    .map((n) => ({ ...n, note: n.note.trim() }))
    .filter((n) => n.note !== "")
    .slice(0, MAX_PROMOTED);
}

/**
 * Journal notes worth promoting into MEMORY.md: one tool-less model call with SDK structured output (`PromotedNotes`).
 * Never throws; a failed call, exhausted schema retries or an answer of the wrong shape gives undefined (the caller
 * then keeps its mark), `[]` means nothing to keep.
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
        maxTurns: STRUCTURED_MAX_TURNS,
        outputFormat: jsonSchemaOutput(PromotedNotes),
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
      if (m.type === "result")
        return m.subtype === "success" ? parsePromoted(m.structured_output) : undefined;
    return undefined;
  } catch {
    return undefined;
  }
}
