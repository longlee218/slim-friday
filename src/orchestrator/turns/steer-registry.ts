import type { Database } from "bun:sqlite";
import { logEvent, logger, tryLog } from "../../observability/logger";
import { ROLES } from "../../roles/role-registry";
import type { SteerRun, SteerSink } from "../../runtime/run-input-channel";
import { ownedTaskOfTurn, runningTurnOfTask, threadOfTask } from "../../storage/owned-task-store";
import { runMessageSourceId, setRunMessageTarget } from "../../storage/run-message-store";
import { createHeldSteers } from "./steer-held";
import { createSteerStore, type MessageRef } from "./steer-store";
import type { SteerEvent, SteerOutcome, SteerRegistry } from "./steer-types";

export type { SteerRegistry } from "./steer-types";

/* Which run can take a steer right now, and the audit of every message that arrives while a run
   works (`run_messages`). A streaming run registers its input sink here, keyed by its TASK (owned task id, else
   turn id), and unregisters when it ends; a thread can hold several tasks. Callers only see `steerTask(task, text)`,
   `record(...)`, `subscribe(...)` and `hook(...)`; they never touch the runtime. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "steer-registry" });

/** Build an empty registry over `db` (the `run_messages` table). */
export function createSteerRegistry(db: Database): SteerRegistry {
  /** Task key of a turn: its owned task id, else the turn id (a turn without a task is its own key). */
  const taskKey = (turnId: string): string => ownedTaskOfTurn(db, turnId) ?? turnId;
  /** taskKey -> input of the task's registered run; insertion order = registration order. */
  const sinks = new Map<string, { sink: SteerSink; run: SteerRun; threadId: string }>();
  /** Newest registered run of a thread, or undefined. */
  const sinkOf = (threadId: string) =>
    [...sinks.values()].filter((e) => e.threadId === threadId).at(-1);
  /** taskKey -> steers held until that task's streaming run registers its input (it is starting). */
  const held = createHeldSteers();
  /** The thread's task that is running (or waits on an approval), with its role. */
  const liveTask = (threadId: string) =>
    db
      .query<{ id: string; role: string }, [string]>(
        `SELECT id, role FROM turns WHERE thread_id = ? AND status IN ('running', 'waiting_approval')
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) ?? undefined;
  /** The running turn of one task (owned task id or turn id), with its role and thread. */
  const liveTurnOfTask = (taskId: string) => runningTurnOfTask(db, taskId);
  /** A running turn is a streaming role (one that reads steers): a message can wait for it. */
  const streams = (t: { role: string } | undefined): boolean => !!(t && ROLES[t.role]?.streaming);
  /** threadId -> observers of the run supervisor, each bound to one target turn. */
  const watchers = new Map<
    string,
    Set<{
      turnId: string;
      onState: (e: SteerEvent) => void;
    }>
  >();
  /** Tell the observers of `turnId` about a steer state (never throws, never blocks the steer). */
  const publish = (
    threadId: string,
    turnId: string | undefined,
    state: SteerEvent["state"],
    messageId?: string,
  ) => {
    if (!turnId) return;
    for (const w of watchers.get(threadId) ?? [])
      if (w.turnId === turnId)
        tryLog(log, "steer observer failed", () =>
          w.onState({ state, ...(messageId && { messageId }) }),
        );
  };
  const { finalize, store } = createSteerStore(db, log, {
    runOf: (threadId) => sinkOf(threadId)?.run,
    liveTurnId: (threadId) => liveTask(threadId)?.id,
  });
  /**
   * Store the steer, then push it into the task's registered run (`entry`), else hold it under `holdKey` until that
   * run registers (it is starting), else it has no taker (`none`).
   */
  const deliver = (
    m: MessageRef,
    text: string,
    entry: { sink: SteerSink; run: SteerRun } | undefined,
    holdKey: string | undefined,
    liveTurnId: string | undefined,
  ): SteerOutcome => {
    const ref = store(m, text, "steer", "pending", { run: entry?.run, turnId: liveTurnId });
    if (entry) {
      const res = entry.sink.push(text, ref);
      if (res === "queued" || res === "late") {
        logEvent(log, "task.steer", { len: text.length });
        publish(m.threadId, entry.run.turnId, "queued"); // pushed, NOT delivered
        return { result: "queued" };
      }
      finalize(ref, "skipped"); // never given to the run: its row is final
      return { result: res === "full" ? "full" : "none" };
    }
    // No run to take it, now or later (no running task, or its role reads no steers).
    if (!holdKey) {
      finalize(ref, "skipped");
      return { result: "none" };
    }
    // The streaming run has no input to push into yet: keep it until it registers.
    if (!held.add(holdKey, m.threadId, { ref, text })) {
      finalize(ref, "skipped");
      return { result: "full" };
    }
    logEvent(log, "task.steer", { len: text.length, held: true });
    publish(m.threadId, liveTurnId, "held");
    return { result: "held" };
  };
  return {
    subscribe(threadId, turnId, onState) {
      const w = { turnId, onState };
      watchers.set(threadId, (watchers.get(threadId) ?? new Set()).add(w));
      return () => void watchers.get(threadId)?.delete(w);
    },
    hook: (threadId) => {
      /** Turn of this hook's run (settle comes after the sink was unregistered). */
      let runTurn: string | undefined;
      return {
        register(sink, run) {
          runTurn = run.turnId;
          const key = taskKey(run.turnId);
          sinks.set(key, { sink, run, threadId });
          // Steers held while the run was starting go into its input, in arrival order.
          for (const w of held.take(key)) {
            const res = sink.push(w.text, w.ref);
            if (res === "queued" || res === "late") {
              publish(threadId, run.turnId, "queued");
              if (w.ref)
                tryLog(log, "run message update failed", () =>
                  setRunMessageTarget(db, w.ref as string, run.turnId),
                );
            } else {
              finalize(w.ref, "dropped");
            }
          }
          // Only remove our own entry: a later run may already have registered its sink.
          return () => {
            if (sinks.get(key)?.sink === sink) sinks.delete(key);
          };
        },
        settle(steer, fate) {
          finalize(steer.ref, fate);
          const messageId = steer.ref ? runMessageSourceId(db, steer.ref) : undefined;
          publish(threadId, runTurn, fate, messageId); // `delivered` only here: the SDK replay (or a verified resume) settled it
        },
      };
    },
    steerTask(taskId, text, messageId) {
      const key = taskKey(taskId); // a turn id is accepted too
      const entry = sinks.get(key);
      const live = liveTurnOfTask(key);
      const threadId = entry?.threadId ?? live?.threadId ?? threadOfTask(db, key);
      if (!threadId) return { result: "none" };
      return deliver(
        { threadId, messageId },
        text,
        entry,
        streams(live) ? key : undefined,
        live?.id,
      );
    },
    record: (m, text, kind, status = "delivered") => void store(m, text, kind, status),
  };
}
