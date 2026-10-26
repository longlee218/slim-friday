import { query } from "@anthropic-ai/claude-agent-sdk";
import type { FlushNote } from "@friday/core";
import { sdkEnv } from "../floor/sdk-env";
import type { QueryFn } from "./build-options";
import { NOTE_CALL_TIMEOUT_MS, timeoutController } from "./call-timeout";
import {
  EXTRACT_SYSTEM_PROMPT,
  type ExtractSource,
  extractUserPrompt,
  MAX_NOTES,
} from "./extract-notes-prompt";
import { ExtractedNotes, jsonSchemaOutput, STRUCTURED_MAX_TURNS } from "./note-output-schema";

/** Longest summary text sent to the extraction call. */
const MAX_INPUT = 20000;

/**
 * Notes worth keeping from a compaction summary or a transcript: one tool-less model call with SDK structured output
 * (`ExtractedNotes`). A failed, aborted (time limit) or unanswered call, exhausted schema retries or an answer of the
 * wrong shape rejects, so the caller logs it.
 */
export async function extractNotes(
  summary: string,
  opts: {
    model: string;
    queryFn?: QueryFn;
    /** Source env (scrubbed like a bot's: no API key or base URL can redirect the call). */
    env?: Record<string, string | undefined>;
    oauthToken?: string;
    /** Give the call up after this long (ms); default `NOTE_CALL_TIMEOUT_MS`. */
    timeoutMs?: number;
    /** What `input` is: a compaction summary (default) or the raw lines of a short session. */
    source?: ExtractSource;
    /** Today's local date (`YYYY-MM-DD`) given to the model; the runtime reads no clock, so the caller sets it. */
    today?: string;
    /** The bot the session belongs to, and its group when the session is a group's. */
    botId?: string;
    groupId?: string;
    /** What the bot's config, the owner's USER/SOUL and the group's instructions already say (not worth a note). */
    known?: string;
  },
): Promise<FlushNote[]> {
  const run = (opts.queryFn ?? query)({
    prompt: extractUserPrompt(summary.slice(0, MAX_INPUT), opts.source ?? "summary", opts.today, {
      botId: opts.botId,
      groupId: opts.groupId,
      known: opts.known,
    }),
    options: {
      model: opts.model,
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      tools: [],
      maxTurns: STRUCTURED_MAX_TURNS,
      outputFormat: jsonSchemaOutput(ExtractedNotes),
      settingSources: [],
      abortController: timeoutController(opts.timeoutMs ?? NOTE_CALL_TIMEOUT_MS),
      env: sdkEnv({ hasRealAuth: !!opts.oauthToken, oauthToken: opts.oauthToken }, opts.env ?? {}, {
        oneShot: true,
      }),
    },
  });
  for await (const m of run) {
    if (m.type !== "result") continue;
    if (m.subtype !== "success") throw new Error(`note extraction failed: ${m.subtype}`);
    const answer = ExtractedNotes.safeParse(m.structured_output);
    if (!answer.success) throw new Error("note extraction answered in the wrong shape");
    return answer.data.notes.filter((n) => n.note.trim() !== "").slice(0, MAX_NOTES);
  }
  throw new Error("note extraction ended without a result");
}
