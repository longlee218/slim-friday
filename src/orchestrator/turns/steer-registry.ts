import type { Database } from "bun:sqlite";
import type { MessageReactionPort } from "../../ingress/message-reaction";
import { STEER_READ_EMOJI } from "../../ingress/message-reaction";
import { logEvent, logger, tryLog } from "../../observability/logger";
import { canonicalRoleName } from "../../roles/role-aliases";
import { ROLES } from "../../roles/role-registry";
import type { SteerRun, SteerSink } from "../../runtime/run-input-channel";
import { ownedTaskOfTurn, runningTurnOfTask, threadOfTask } from "../../storage/owned-task-store";
import { runMessageSourceId, setRunMessageTarget } from "../../storage/run-message-store";
import { taskRunOf } from "../engine/task-runs";
import { createHeldSteers } from "./steer-held";
import { createSteerStore, type MessageRef } from "./steer-store";
import type { SteerEvent, SteerOutcome, SteerRegistry } from "./steer-types";

export type { SteerEvent, SteerOutcome, SteerRegistry, SteerResult } from "./steer-types";
export type { MessageRef };

/* Which run can take a steer right now, and the audit of every message that arrives while a run
   works (`run_messages`). A streaming run registers its input sink here, keyed by its TASK (owned task id, else
   turn id), and unregisters when it ends; a thread can hold several tasks, the thread's next owner message goes to the newest. The thread table (thread/route-by-intent.ts) only sees
   `steer(task, text)`, `record(...)` and `canSteer(...)`; it never touches the runtime. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "steer-registry" });

/** Build an empty registry over `db` (the `run_messages` table). */
export function createSteerRegistry(db: Database, reactions?: MessageReactionPort): SteerRegistry {
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
  const streams = (t: { role: string } | undefined): boolean =>
    !!(t && ROLES[canonicalRoleName(t.role)]?.streaming);
  const canHold = (threadId: string): boolean => streams(liveTask(threadId));
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
  const { finalize, drop, store, takeNotice } = createSteerStore(db, log, {
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
              drop(threadId, w.text);
            }
          }
          // Only remove our own entry: a later run may already have registered its sink.
          return () => {
            if (sinks.get(key)?.sink === sink) sinks.delete(key);
          };
        },
        settle(steer, fate) {
          finalize(steer.ref, fate);
          if (fate === "dropped") drop(threadId, steer.text);
          const messageId = steer.ref ? runMessageSourceId(db, steer.ref) : undefined;
          // The agent read it (SDK replay): a quiet receipt on the owner's message. A failure is logged by the port, never thrown.
          if (fate === "delivered" && messageId && reactions)
            void reactions.react(threadId, messageId, STEER_READ_EMOJI).catch(() => undefined);
          publish(threadId, runTurn, fate, messageId); // `delivered` only here: the SDK replay (or a verified resume) settled it
        },
      };
    },
    liveTasksOf: (threadId) =>
      [...sinks.entries()].filter(([, e]) => e.threadId === threadId).map(([k]) => k),
    canSteer: (threadId) => !!sinkOf(threadId),
    canTake: (threadId) => !!sinkOf(threadId) || canHold(threadId),
    steer(m, text) {
      const live = liveTask(m.threadId);
      // The target is the running task; its OWN sink (never another task's) takes the steer. No running turn row at
      // all (a bare sink): the thread's newest sink.
      const key = live && taskKey(live.id);
      const entry = key ? sinks.get(key) : sinkOf(m.threadId);
      return deliver(m, text, entry, live && streams(live) ? key : undefined, live?.id);
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
    undeliveredNotice(threadId) {
      // Steers still held when the call ends never found a run to read them, except those of a live detached task
      // (its run has not registered its input yet and will take them).
      for (const w of held.takeAbandoned(threadId, (key) => !!taskRunOf(key))) {
        finalize(w.ref, "dropped");
        drop(threadId, w.text);
      }
      return takeNotice(threadId);
    },
  };
}
