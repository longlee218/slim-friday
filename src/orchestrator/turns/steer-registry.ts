import type { Database } from "bun:sqlite";
import { excerpt, logEvent, logger, tryLog } from "../../observability/logger";
import { redactText } from "../../observability/redact";
import { ROLES } from "../../roles/role-registry";
import {
  MAX_PENDING_STEERS,
  type SteerHook,
  type SteerRun,
  type SteerSink,
} from "../../runtime/run-input-channel";
import {
  insertRunMessage,
  type RunMessageKind,
  type RunMessageStatus,
  setRunMessageStatus,
  setRunMessageTarget,
} from "../../storage/run-message-store";
import { turnSessionId } from "../../storage/run-store";
import { gatePassed } from "../../storage/stage-store";
import { NOT_DELIVERED } from "../thread/intent-replies";

/* Which run of a thread can take a steer right now, and the audit of every message that arrives while a run
   works (`run_messages`). A streaming stage registers its input sink here and unregisters when it ends; the
   thread's next owner message looks it up. The thread table (thread/route-by-intent.ts) only sees
   `steer(task, text)`, `record(...)` and `canSteer(...)`; it never touches the runtime. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "steer-registry" });

/**
 * What a steer did: `queued` for the running stage (also: kept for a resume), `held` for the next streaming stage of
 * the same task (the run is between stages), `full` (too many pending), or `none` (no run can take it).
 */
export type SteerResult = "queued" | "held" | "full" | "none";

/** A steer and what the registry did with it; `afterPlan` = the task already passed its approved plan gate. */
export interface SteerOutcome {
  result: SteerResult;
  afterPlan: boolean;
}

/** The facts of an owner message the registry stores. */
export interface MessageRef {
  threadId: string;
  /** Ingress message id (Discord), when known. */
  messageId?: string;
}

/** Longest message shown in the not-delivered notice (chars). */
const NOTICE_EXCERPT = 120;

/** The registry the handler owns (one per process; one entry per thread: one run per thread). */
export interface SteerRegistry {
  /** Hook for the stage runner: a run of `threadId` registers its sink through it. */
  hook(threadId: string): SteerHook;
  /** A run of `threadId` is registered right now (a steer can be pushed). */
  canSteer(threadId: string): boolean;
  /** A steer can be taken now (a sink is registered) or later (the thread's running task has a streaming stage still to come). */
  canTake(threadId: string): boolean;
  /** Store the message, then push it into the thread's running stage, or hold it for the next streaming stage. Logs `task.steer {len}` (never the body). */
  steer(m: MessageRef, text: string): SteerOutcome;
  /** Store a message that arrived while a run works and was handled elsewhere (queue, stop). Never throws. */
  record(m: MessageRef, text: string, kind: RunMessageKind, status?: RunMessageStatus): void;
  /** The notice for steers the run never read, held ones included (`""` when none), and forget them. */
  undeliveredNotice(threadId: string): string;
}

/** Build an empty registry over `db` (the `run_messages` table). */
export function createSteerRegistry(db: Database): SteerRegistry {
  const sinks = new Map<string, { sink: SteerSink; run: SteerRun }>();
  /** threadId -> texts of steers that were never read, for the notice at the end of the call. */
  const dropped = new Map<string, string[]>();
  /** threadId -> steers held for the next streaming stage (the run is between stages). */
  const held = new Map<string, { ref?: string; text: string }[]>();
  /** The thread's task that is running (or waits on an approval), with its role. */
  const liveTask = (threadId: string) =>
    db
      .query<{ id: string; role: string }, [string]>(
        `SELECT id, role FROM turns WHERE thread_id = ? AND status IN ('running', 'waiting_approval')
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) ?? undefined;
  /** The thread's running task has a streaming stage (one that reads steers): a message can wait for it. */
  const canHold = (threadId: string): boolean => {
    const t = liveTask(threadId);
    const role = t && ROLES[t.role];
    return !!role && role.stages.some((s) => s.streaming);
  };
  /** Mark a row final without raising. */
  const finalize = (ref: string | undefined, status: RunMessageStatus) => {
    if (ref) tryLog(log, "run message update failed", () => setRunMessageStatus(db, ref, status));
  };
  const drop = (threadId: string, text: string) =>
    dropped.set(threadId, [...(dropped.get(threadId) ?? []), text]);
  /** Best-effort row write: the audit never breaks routing. */
  const store = (
    m: MessageRef,
    text: string,
    kind: RunMessageKind,
    status: RunMessageStatus,
  ): string | undefined => {
    const run = sinks.get(m.threadId)?.run;
    let id: string | undefined;
    tryLog(log, "run message store failed", () => {
      const turnId = run?.turnId ?? liveTask(m.threadId)?.id;
      id = insertRunMessage(db, {
        messageId: m.messageId,
        threadId: m.threadId,
        runId: run?.runId,
        sessionId: run && turnSessionId(db, run.turnId),
        kind,
        status,
        content: text,
        taskId: turnId,
        afterPlan: kind === "steer" && !!turnId && gatePassed(db, turnId),
      });
    });
    logEvent(log, "run_message.stored", { kind, len: text.length });
    return id;
  };
  return {
    hook: (threadId) => ({
      register(sink, run) {
        const entry = { sink, run };
        sinks.set(threadId, entry);
        // Steers held while the run was between stages go into this stage's input, in arrival order.
        const waiting = held.get(threadId) ?? [];
        held.delete(threadId);
        for (const w of waiting) {
          const res = sink.push(w.text, w.ref);
          if (res === "queued" || res === "late") {
            if (w.ref)
              tryLog(log, "run message update failed", () =>
                setRunMessageTarget(db, w.ref as string, {
                  taskId: run.turnId,
                  afterPlan: gatePassed(db, run.turnId),
                }),
              );
          } else {
            finalize(w.ref, "dropped");
            drop(threadId, w.text);
          }
        }
        // Only remove our own entry: a later stage may already have registered its sink.
        return () => {
          if (sinks.get(threadId)?.sink === sink) sinks.delete(threadId);
        };
      },
      settle(steer, fate) {
        finalize(steer.ref, fate);
        if (fate === "dropped") drop(threadId, steer.text);
      },
    }),
    canSteer: (threadId) => sinks.has(threadId),
    canTake: (threadId) => sinks.has(threadId) || canHold(threadId),
    steer(m, text) {
      const afterPlan = (id?: string) => !!id && gatePassed(db, id);
      const sink = sinks.get(m.threadId);
      const ref = store(m, text, "steer", "pending");
      if (sink) {
        const res = sink.sink.push(text, ref);
        if (res === "queued" || res === "late") {
          logEvent(log, "task.steer", { len: text.length });
          return { result: "queued", afterPlan: afterPlan(sink.run.turnId) };
        }
        finalize(ref, "skipped"); // never given to the run: its row is final
        return { result: res === "full" ? "full" : "none", afterPlan: false };
      }
      // No run to take it, now or later (no running task, or none of its stages reads steers).
      if (!canHold(m.threadId)) {
        finalize(ref, "skipped");
        return { result: "none", afterPlan: false };
      }
      // Between streaming stages: keep it for the next one (the run has no input to push into right now).
      const waiting = held.get(m.threadId) ?? [];
      if (waiting.length >= MAX_PENDING_STEERS) {
        finalize(ref, "skipped");
        return { result: "full", afterPlan: false };
      }
      held.set(m.threadId, [...waiting, { ref, text }]);
      logEvent(log, "task.steer", { len: text.length, held: true });
      return { result: "held", afterPlan: afterPlan(liveTask(m.threadId)?.id) };
    },
    record: (m, text, kind, status = "delivered") => void store(m, text, kind, status),
    undeliveredNotice(threadId) {
      // Steers still held when the call ends found no streaming stage: they were never read.
      for (const w of held.get(threadId) ?? []) {
        finalize(w.ref, "dropped");
        drop(threadId, w.text);
      }
      held.delete(threadId);
      const texts = dropped.get(threadId);
      dropped.delete(threadId);
      if (!texts?.length) return "";
      const lines = texts.map((t) => `- ${excerpt(redactText(t), NOTICE_EXCERPT)}`);
      return `${NOT_DELIVERED}\n${lines.join("\n")}`;
    },
  };
}
