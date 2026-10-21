import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  REFLECT_INPUT_MAX_CHARS,
  REFLECT_MAX_PER_TICK,
  REFLECT_WINDOW_MS,
} from "../config/memory-caps";
import { logEvent, logger } from "../observability/logger";
import { errText, redactText } from "../observability/redact";
import { REFLECT_SYSTEM } from "../roles/prompts/memory-prompts";
import { markPromoted } from "../storage/memory-promotion-store";
import { goalFacts, goalsToReflect, reflectMark } from "../storage/reflection-store";
import { appendJournalBlock } from "./daily-journal";
import type { ChannelResolver } from "./idle-episode";
import { reindexFile } from "./index/memory-index";
import { safely } from "./index/safely";
import { formatLesson, type LessonParts } from "./lesson-format";
import type { CompactLlm } from "./memory-compaction-llm";

const log = logger.child({ module: "goal-reflection" });

/** Collaborators of the reflection writer (tests pass a fake `llm`, a fixed clock and a fake resolver). */
export interface ReflectDeps {
  db: Database;
  home: string;
  llm: CompactLlm;
  resolve: ChannelResolver;
  now?: () => number;
  /** Shutdown: stops the batch; an aborted call writes and marks nothing (the goal stays eligible). */
  signal?: AbortSignal;
}

/** The model reply: a lesson, or the explicit no-entry answer. */
const lessonSchema = z.object({
  cue: z.string().trim().min(1),
  lesson: z.string().trim().min(1),
  evidence: z.string().trim().min(1),
});

/** Parse the reply (JSON, also inside a fence or text): the lesson, "none" for NO_ENTRY, or null when unusable. */
function parseReply(text: string): LessonParts | "none" | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { entry?: unknown };
    if (raw?.entry === "NO_ENTRY") return "none";
    const one = lessonSchema.safeParse(raw);
    return one.success ? one.data : null;
  } catch {
    return null; // not JSON
  }
}

/**
 * Reflect on goals that closed with a failure signal (see `goalsToReflect`) within `REFLECT_WINDOW_MS`, at most
 * `REFLECT_MAX_PER_TICK` per call, oldest first. One model call per goal over its db facts; a lesson goes to the
 * channel journal as kind `lesson` (evidence prefixed with the goal id), where dreaming merges it. NO_ENTRY, a bad reply,
 * a model error or an unmapped channel write nothing; every outcome marks the goal except a shutdown abort and a busy
 * journal lock (retried next tick). Logs `memory.reflection {outcome}` (never the text). Returns the lessons written.
 * Never throws.
 */
export async function reflectClosedGoals(d: ReflectDeps): Promise<number> {
  const now = d.now?.() ?? Date.now();
  let written = 0;
  try {
    for (const g of goalsToReflect(d.db, now - REFLECT_WINDOW_MS, REFLECT_MAX_PER_TICK)) {
      if (d.signal?.aborted) break;
      const where = g.channelId ? d.resolve(g.channelId) : null;
      const mark = () =>
        markPromoted(
          d.db,
          where?.workspace ?? "",
          where?.channel ?? "",
          [reflectMark(g.goalId)],
          now,
        );
      let outcome = "unmapped";
      if (where?.channel) {
        const input = redactText(goalFacts(d.db, g.goalId)).slice(0, REFLECT_INPUT_MAX_CHARS);
        let reply: LessonParts | "none" | null = null;
        try {
          reply = parseReply((await d.llm(REFLECT_SYSTEM, input, d.signal)).text);
          outcome = reply === "none" ? "no_entry" : reply ? "lesson" : "bad_reply";
        } catch (err) {
          if (d.signal?.aborted) break;
          outcome = "llm_failed";
          logEvent(log, "memory.reflection_llm_failed", { err: errText(err, 200) }, "warn");
        }
        if (reply && reply !== "none") {
          const res = appendJournalBlock({
            home: d.home,
            workspace: where.workspace,
            channel: where.channel,
            label: `Reflection - goal ${g.goalId.slice(0, 8)}`,
            items: [
              {
                kind: "lesson",
                text: formatLesson({
                  ...reply,
                  evidence: `goal ${g.goalId.slice(0, 8)}: ${reply.evidence}`,
                }),
              },
            ],
            now: new Date(now),
          });
          if (res.stopped === "busy") {
            logEvent(log, "memory.reflection", { outcome: "busy" }, "warn");
            continue; // not marked: the next tick tries again
          }
          if (res.saved) {
            written++;
            safely("reindex", () => reindexFile(d.db, d.home, res.file));
          }
        }
      }
      mark();
      logEvent(log, "memory.reflection", { outcome, status: g.status });
    }
  } catch (err) {
    logEvent(log, "memory.reflection_failed", { err: errText(err, 200) }, "warn");
  }
  return written;
}
