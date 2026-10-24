import { query } from "@anthropic-ai/claude-agent-sdk";
import { sdkEnv } from "../floor/sdk-env";
import { NOTE_CALL_TIMEOUT_MS, timeoutController } from "./call-timeout";
import type { QueryFn } from "./build-options";

/** Longest summary text sent to the extraction call. */
const MAX_INPUT = 20000;
/** Most notes one extraction returns. */
const MAX_NOTES = 5;

const SYSTEM_PROMPT =
  "You read a summary of a conversation between a user and an assistant bot. " +
  `List at most ${MAX_NOTES} notes worth remembering in a later conversation. Keep only: a rule or preference ` +
  "the user stated, a decision with its reason, a stable fact about the user or their projects, a lesson from a " +
  "mistake. Skip: task progress or status, one-off questions and answers, what the assistant did or ran, " +
  "details readable from the code or files, guesses the user did not confirm, secrets, and times like " +
  "'today' or 'next week' (write the date or skip the note). When unsure, skip. " +
  "Answer with a JSON array of short strings only, or [] when nothing qualifies.";

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
 * Notes worth keeping from a compaction summary: one tool-less, one-turn model call. Never throws; any failure or
 * an answer that is not a JSON array gives [].
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
  },
): Promise<string[]> {
  try {
    const run = (opts.queryFn ?? query)({
      prompt: summary.slice(0, MAX_INPUT),
      options: {
        model: opts.model,
        systemPrompt: SYSTEM_PROMPT,
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
      if (m.type === "result") return m.subtype === "success" ? parseNotes(m.result) : [];
    return [];
  } catch {
    return [];
  }
}
