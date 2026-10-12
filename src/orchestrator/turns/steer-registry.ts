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
import { NOT_DELIVERED } from "../thread/intent-replies";

/* Which run of a thread can take a steer right now, and the audit of every message that arrives while a run
   works (`run_messages`). A streaming run registers its input sink here and unregisters when it ends; the
   thread's next owner message looks it up. The thread table (thread/route-by-intent.ts) only sees
   `steer(task, text)`, `record(...)` and `canSteer(...)`; it never touches the runtime. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "steer-registry" });

/**
 * What a steer did: `queued` for the running run (also: kept for a resume), `held` until the task's streaming run has
 * registered its input (it is starting), `full` (too many pending), or `none` (no run can take it).
 */
export type SteerResult = "queued" | "held" | "full" | "none";

/** A steer and what the registry did with it. */
export interface SteerOutcome {
  result: SteerResult;
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
  /** Hook for the role runner: a run of `threadId` registers its sink through it. */
  hook(threadId: string): SteerHook;
  /** A run of `threadId` is registered right now (a steer can be pushed). */
  canSteer(threadId: string): boolean;
  /** A steer can be taken now (a sink is registered) or soon (the thread's running task is a streaming role that has not registered yet). */
  canTake(threadId: string): boolean;
  /** Store the message, then push it into the thread's running run, or hold it until the run registers. Logs `task.steer {len}` (never the body). */
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
  /** threadId -> steers held until the thread's streaming run registers its input (it is starting). */
  const held = new Map<string, { ref?: string; text: string }[]>();
  /** The thread's task that is running (or waits on an approval), with its role. */
  const liveTask = (threadId: string) =>
    db
      .query<{ id: string; role: string }, [string]>(
        `SELECT id, role FROM turns WHERE thread_id = ? AND status IN ('running', 'waiting_approval')
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) ?? undefined;
  /** The thread's running task is a streaming role (one that reads steers): a message can wait for it. */
  const canHold = (threadId: string): boolean => {
    const t = liveTask(threadId);
    const role = t && ROLES[t.role];
    return !!role?.streaming;
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
        // Steers held while the run was starting go into its input, in arrival order.
        const waiting = held.get(threadId) ?? [];
        held.delete(threadId);
        for (const w of waiting) {
          const res = sink.push(w.text, w.ref);
          if (res === "queued" || res === "late") {
            if (w.ref)
              tryLog(log, "run message update failed", () =>
                setRunMessageTarget(db, w.ref as string, run.turnId),
              );
          } else {
            finalize(w.ref, "dropped");
            drop(threadId, w.text);
          }
        }
        // Only remove our own entry: a later run may already have registered its sink.
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
      const sink = sinks.get(m.threadId);
      const ref = store(m, text, "steer", "pending");
      if (sink) {
        const res = sink.sink.push(text, ref);
        if (res === "queued" || res === "late") {
          logEvent(log, "task.steer", { len: text.length });
          return { result: "queued" };
        }
        finalize(ref, "skipped"); // never given to the run: its row is final
        return { result: res === "full" ? "full" : "none" };
      }
      // No run to take it, now or later (no running task, or its role reads no steers).
      if (!canHold(m.threadId)) {
        finalize(ref, "skipped");
        return { result: "none" };
      }
      // The streaming run has no input to push into yet: keep it until it registers.
      const waiting = held.get(m.threadId) ?? [];
      if (waiting.length >= MAX_PENDING_STEERS) {
        finalize(ref, "skipped");
        return { result: "full" };
      }
      held.set(m.threadId, [...waiting, { ref, text }]);
      logEvent(log, "task.steer", { len: text.length, held: true });
      return { result: "held" };
    },
    record: (m, text, kind, status = "delivered") => void store(m, text, kind, status),
    undeliveredNotice(threadId) {
      // Steers still held when the call ends never found a run to read them.
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
