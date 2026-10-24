import { query } from "@anthropic-ai/claude-agent-sdk";
import { sdkEnv } from "../floor/sdk-env";
import type { QueryFn } from "./build-options";
import { NOTE_CALL_TIMEOUT_MS, timeoutController } from "./call-timeout";
import {
  EXTRACT_SYSTEM_PROMPT,
  type ExtractSource,
  extractUserPrompt,
  MAX_NOTES,
} from "./extract-notes-prompt";

/** Longest summary text sent to the extraction call. */
const MAX_INPUT = 20000;

/** The first JSON array of strings in `text`, or [] when there is none. */
function parseNotes(text: string): string[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .slice(0, MAX_NOTES);
  } catch {
    return [];
  }
}

/**
 * Notes worth keeping from a compaction summary or a transcript: one tool-less, one-turn model call. An answer that
 * is not a JSON array gives []; a failed, aborted (time limit) or unanswered call rejects, so the caller logs it.
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
  },
): Promise<string[]> {
  const run = (opts.queryFn ?? query)({
    prompt: extractUserPrompt(summary.slice(0, MAX_INPUT), opts.source ?? "summary", opts.today),
    options: {
      model: opts.model,
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      tools: [],
      maxTurns: 1,
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
    return parseNotes(m.result);
  }
  throw new Error("note extraction ended without a result");
}
