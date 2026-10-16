import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { logEvent, tryLog } from "../../observability/logger";
import type { SteerRun } from "../../runtime/run-input-channel";
import {
  insertRunMessage,
  type RunMessageKind,
  type RunMessageStatus,
  setRunMessageStatus,
} from "../../storage/run-message-store";
import { turnSessionId } from "../../storage/run-store";

/* The audit side of the steer registry: `run_messages` rows (insert / final status). No sinks and no held steers here. */

/** The facts of an owner message the registry stores. */
export interface MessageRef {
  threadId: string;
  /** Ingress message id (Discord), when known. */
  messageId?: string;
}

/** What the store needs to know about live runs. */
export interface SteerStoreLookup {
  /** Run of the thread's newest registered sink, when any. */
  runOf(threadId: string): SteerRun | undefined;
  /** Turn id of the thread's running task, when any. */
  liveTurnId(threadId: string): string | undefined;
}

/** Build the store over `db`. */
export function createSteerStore(db: Database, log: Logger, lookup: SteerStoreLookup) {
  return {
    /** Mark a row final without raising. */
    finalize(ref: string | undefined, status: RunMessageStatus): void {
      if (ref) tryLog(log, "run message update failed", () => setRunMessageStatus(db, ref, status));
    },
    /** Best-effort row write: the audit never breaks routing. `target` pins the run / turn the row is about. */
    store(
      m: MessageRef,
      text: string,
      kind: RunMessageKind,
      status: RunMessageStatus,
      target?: { run?: SteerRun; turnId?: string },
    ): string | undefined {
      const run = target ? target.run : lookup.runOf(m.threadId);
      let id: string | undefined;
      tryLog(log, "run message store failed", () => {
        const turnId = run?.turnId ?? target?.turnId ?? lookup.liveTurnId(m.threadId);
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
    },
  };
}
