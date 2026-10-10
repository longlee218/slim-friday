import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/* Streaming input of one run (steer). With a string prompt the SDK takes ONE user message and the owner cannot
   add to it. Here the prompt is an `AsyncIterable<SDKUserMessage>`: first item = the task prompt, later items =
   owner messages pushed while the run works. The CLI pulls them at once but hands them to the model only at the
   next turn boundary, i.e. AFTER the current turn's tools (spike Q16: same-turn tools are not skipped); a
   subagent never sees them. The CLI echoes each consumed user message (`replay-user-messages`, isReplay), and
   that echo is the only proof of delivery: results cannot be counted against pushes (steers merge into a turn).
   Nothing here touches the guard, the budget or the gates: a steer is plain user text. */

/** Max steers waiting in the channel (pushed, not yet pulled by the SDK) per run; one more is refused. */
export const MAX_PENDING_STEERS = 5;

/** How many `result`s a run waits for a steer that was not echoed yet (the hold bound of step 7). */
export const MAX_STEER_HOLDS = 2;

/** How many times a message that arrived after the iterable returned resumes the same session (once). */
export const MAX_LATE_RESUMES = 1;

/** Text compared for an echo: trimmed, whitespace runs collapsed (the CLI may re-wrap what the owner typed). */
export const normalizeEcho = (t: string): string => t.trim().replace(/\s+/g, " ");

/** What `push` did: queued for the model, kept for a resume (input already ended), refused (cap) or refused (closed for good). */
export type PushResult = "queued" | "late" | "full" | "closed";

/** One pushed steer: `ref` is the caller's id of it (its `run_messages` row), `text` the message. */
export interface Steer {
  ref?: string;
  text: string;
}

/** The part of a channel the owner-facing side sees (the registry holds this, never the iterable). */
export interface SteerSink {
  push(text: string, ref?: string): PushResult;
}

/** Facts of the run a sink belongs to (stored with each message the owner sends to it). */
export interface SteerRun {
  runId: string;
  taskId: string;
}

/** Registers a run's sink so the thread's next message can steer it; returns the unregister function. */
export interface SteerHook {
  register(sink: SteerSink, run: SteerRun): () => void;
  /** A pushed steer's fate: read by the model (echo, or resent in a resumed turn) or not delivered. */
  settle(steer: Steer, fate: "delivered" | "dropped"): void;
}

/** A push queue that is also the SDK's `prompt` iterable. */
export interface InputChannel extends SteerSink {
  /** Pass as `query({ prompt })`. Single use: one consumer. */
  iterable: AsyncIterable<SDKUserMessage>;
  /** Steers pushed and not yet pulled (the first prompt does not count). */
  pending(): number;
  /** Steers pushed and not echoed back yet (queued, or pulled but not confirmed). */
  unechoed(): Steer[];
  /** An echoed user message: marks the first not-echoed steer with this text as delivered and returns it. */
  echoed(text: string): Steer | undefined;
  /** Steers that arrived after `close()` without discard (the run's input ended): resend them in a resumed turn. */
  late(): Steer[];
  /**
   * No more pushes. `discard` = stop / timeout / run end: queued items are dropped and later pushes are refused.
   * Else the consumer still gets the queued items and then the iteration ends (a later push is kept as `late`).
   */
  close(discard?: boolean): void;
}

/** One user turn as the SDK expects it on the input stream. */
const userMessage = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

/** Build the channel; `first` is the task prompt (yielded first, not counted against the cap). */
export function createInputChannel(first: string, max = MAX_PENDING_STEERS): InputChannel {
  /** Queued items; `steer` is set for an owner steer (the first prompt is not one). */
  const queue: { msg: SDKUserMessage; steer?: Steer }[] = [{ msg: userMessage(first) }];
  /** Every steer pushed and not echoed yet, in push order. */
  const awaiting: Steer[] = [];
  const lateSteers: Steer[] = [];
  let queuedSteers = 0; // queue items that are steers
  let closed = false;
  let hard = false; // closed with discard: nothing will read a later push
  /** Wakes the consumer waiting on an empty queue. */
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  async function* items(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        if (next.steer) queuedSteers--;
        yield next.msg;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  return {
    iterable: items(),
    pending: () => queuedSteers,
    unechoed: () => [...awaiting],
    late: () => [...lateSteers],
    echoed(text) {
      const norm = normalizeEcho(text);
      const at = awaiting.findIndex((s) => normalizeEcho(s.text) === norm);
      return at < 0 ? undefined : awaiting.splice(at, 1)[0];
    },
    push(text, ref) {
      const steer: Steer = { text, ...(ref && { ref }) };
      if (closed) {
        if (hard) return "closed";
        lateSteers.push(steer);
        return "late";
      }
      if (queuedSteers >= max) return "full";
      queue.push({ msg: userMessage(text), steer });
      awaiting.push(steer);
      queuedSteers++;
      notify();
      return "queued";
    },
    close(discard = false) {
      closed = true;
      if (discard) {
        hard = true;
        queue.length = 0;
        queuedSteers = 0;
      }
      notify();
    },
  };
}
