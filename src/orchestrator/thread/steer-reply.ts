import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import type { DispatchDeps } from "../dispatch/dispatch-role";
import { STEER_REACT_REPLY } from "./steer-notice-sentinel";
import { threadToolApproval } from "./thread-state";

/** The same steer notice (same thread and state) is not re-sent inside this window: the owner gets a reaction instead. */
export const STEER_DEDUPE_MS = 60_000;

/** Most threads remembered by the dedupe map; the oldest entry goes first (the map is in-memory, never grows without bound). */
const DEDUPE_MAX_THREADS = 200;

/** Only these notices dedupe: they are plain receipts. `full` (input refused) and `ended` (nothing running) must be read. */
const DEDUPED_STATES: ReadonlySet<string> = new Set(["queued", "held", "waiting"]);

/** threadId -> the last steer notice state sent and when (Map keeps insertion order: oldest first). */
const lastNotice = new Map<string, { state: string; at: number }>();

/** True when this notice repeats the one sent for the thread less than `STEER_DEDUPE_MS` ago; records it otherwise. */
export function isRepeatedNotice(threadId: string, state: string, now: number): boolean {
  if (!DEDUPED_STATES.has(state)) return false; // `full` and `ended` always send their text
  const last = lastNotice.get(threadId);
  if (last && last.state === state && now - last.at < STEER_DEDUPE_MS) return true;
  lastNotice.delete(threadId); // re-insert: this thread becomes the newest entry
  lastNotice.set(threadId, { state, at: now });
  if (lastNotice.size > DEDUPE_MAX_THREADS)
    lastNotice.delete(lastNotice.keys().next().value as string);
  return false;
}

/** Forget every remembered notice (tests). */
export const resetNoticeDedupe = (): void => lastNotice.clear();

/**
 * Plain user text into the running run's input: no scope, guard, budget or gate changes (see steer-registry.ts).
 * The reply says "received", never that the agent read it (it reads at its next turn boundary). While a tool approval
 * waits it says so (the message is stored and delivered after the decision). The same notice twice within
 * `STEER_DEDUPE_MS` returns `STEER_REACT_REPLY` (the handler reacts instead of repeating the text).
 */
export function steerReply(
  deps: DispatchDeps,
  message: InboundMessage,
  text: string,
  now: () => number = Date.now,
): string {
  const sent = deps.steer?.steer(message, text);
  const state =
    sent?.result === "queued" && threadToolApproval(deps.db, message.threadId)
      ? "waiting"
      : sent?.result === "queued"
        ? "queued"
        : sent?.result === "held"
          ? "held"
          : sent?.result === "full"
            ? "full"
            : "ended";
  if (isRepeatedNotice(message.threadId, state, now())) return STEER_REACT_REPLY;
  return renderUserNotice({ kind: "steer", state }, messageLanguage(message));
}
