import type { Database } from "bun:sqlite";
import { clip, redactText } from "../../observability/redact";
import type { AskQuestion } from "../../runtime/tool-permissions";
import { appendEvent } from "../../storage/thread-event-store";

/* Worker question relay: a lead-dispatched worker never asks the owner itself. Its AskUserQuestion becomes a `question`
   event (the lead reads it in an announce run) and the worker waits until the lead answers it (SteerTask) or relays
   it to the owner (AskOwner). The wait is bounded; nobody answering ends the run's ask like an owner timeout. */

/** Longest wait (ms) for an answer before the worker's ask fails. */
const RELAY_WAIT_MS = 30 * 60_000;

/** Chars of a question kept in the event. */
const QUESTION_CHARS = 600;

/** One worker waiting for an answer. */
interface Waiting {
  questions: AskQuestion[];
  resolve: (answers: Record<string, string> | undefined) => void;
}

/** The relay of a process: workers wait here, the lead's tools answer. */
export interface QuestionRelay {
  /** Build the `askRelay` of one worker run (`itemId` = its owned task). */
  forWorker(w: {
    threadId: string;
    goalId: string;
    itemId: string;
    turnId: string;
  }): (questions: AskQuestion[]) => Promise<Record<string, string> | undefined>;
  /** Hand an answer to the worker waiting on `itemId`; false when none waits. */
  answer(itemId: string, text: string): boolean;
  /** Ends every wait of one thread with no answer (`/stop`): a late answer finds nobody waiting. */
  abortThread(threadId: string): void;
  /** Ends every wait with no answer (shutdown). */
  abortAll(): void;
}

/** Build the relay. `onQuestion` wakes the lead (announce) after the event is written. */
export function createQuestionRelay(
  db: Database,
  onQuestion: (threadId: string) => void,
  waitMs = RELAY_WAIT_MS,
): QuestionRelay {
  /** itemId -> the worker's pending ask (one at a time per worker). */
  const waiting = new Map<string, Waiting & { threadId: string; goalId: string }>();
  return {
    forWorker: (w) => (questions) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => finish(undefined), waitMs);
        timer.unref();
        const finish = (a: Record<string, string> | undefined) => {
          clearTimeout(timer);
          waiting.delete(w.itemId);
          resolve(a);
        };
        waiting.set(w.itemId, {
          questions,
          resolve: finish,
          threadId: w.threadId,
          goalId: w.goalId,
        });
        const text = questions.map((q) => q.question).join("\n");
        appendEvent(db, {
          id: `question:${w.turnId}:${crypto.randomUUID()}`,
          threadId: w.threadId,
          taskId: w.goalId,
          itemId: w.itemId,
          kind: "question",
          payload: {
            question: clip(redactText(text), QUESTION_CHARS),
            options: questions.flatMap((q) => q.options.map((o) => o.label)),
          },
        });
        onQuestion(w.threadId);
      }),
    answer(itemId, text) {
      const w = waiting.get(itemId);
      if (!w) return false;
      appendEvent(db, {
        id: `answer:${itemId}:${crypto.randomUUID()}`,
        threadId: w.threadId,
        taskId: w.goalId,
        itemId,
        kind: "answer",
        payload: { text: clip(redactText(text), QUESTION_CHARS), by: "lead" },
      });
      // Every question of the call gets the one answer (the lead answers the whole ask).
      w.resolve(Object.fromEntries(w.questions.map((q) => [q.question, text])));
      return true;
    },
    abortThread(threadId) {
      for (const w of [...waiting.values()]) if (w.threadId === threadId) w.resolve(undefined);
    },
    abortAll() {
      for (const w of [...waiting.values()]) w.resolve(undefined);
    },
  };
}
