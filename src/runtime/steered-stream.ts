import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { addUsage, emptyUsage } from "../observability/record-run";
import {
  createInputChannel,
  MAX_LATE_RESUMES,
  MAX_STEER_HOLDS,
  type Steer,
  type SteerHook,
} from "./run-input-channel";
import { consumeStream, type StreamResult } from "./run-stream";

/* Step 7 of the agent loop (Rev 11, spike Q16): a streaming run must not end while the owner's last message has
   not been read. The channel stays OPEN after a `result` as long as a pushed steer was not echoed back; the CLI
   keeps reading an open input, answers a late message with its own turn and `result`. The wait is bounded
   (MAX_STEER_HOLDS results, and a silence timer so a missing echo cannot hang the run until its timeout). A
   message that arrives after the input ended resumes the SAME session once more (once: MAX_LATE_RESUMES). What is
   still unread at the end is settled `dropped`: the owner is told. */

/** How long a held `result` waits for the CLI to say anything (an echo or a new turn) before the input is ended. */
export const STEER_RESULT_GRACE_MS = 20_000;

/** Text of an echoed (replayed) user message, or undefined for any other stream message. */
function echoText(m: SDKMessage): string | undefined {
  const u = m as { type: string; isReplay?: boolean; message?: { content?: unknown } };
  if (u.type !== "user" || u.isReplay !== true) return undefined;
  const c = u.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return undefined;
  return c
    .filter((b): b is { type: "text"; text: string } => b?.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Two rounds of one run as one result: last text and outcome, usage per `addUsage` (cost cumulative, rest summed). */
function merge(a: StreamResult, b: StreamResult): StreamResult {
  return {
    ...b,
    sessionId: b.sessionId ?? a.sessionId,
    lastText: b.lastText ?? a.lastText,
    usage: addUsage(a.usage, b.usage),
  };
}

/** Inputs: those of `consumeStream` (without its prompt / hooks) plus the first prompt and the owner-facing hook. */
export type SteeredInput = Omit<
  Parameters<typeof consumeStream>[0],
  "prompt" | "onMessage" | "onResult" | "resume"
> & {
  /** The task prompt (first item of the input). */
  first: string;
  hook: SteerHook;
  runId: string;
  /** Silence bound of a held result (tests shorten it). */
  graceMs?: number;
};

/** Consume a streaming-input run; see the file comment. Never throws (consumeStream does not). */
export async function consumeSteered(p: SteeredInput): Promise<StreamResult> {
  const { first, hook, runId, graceMs = STEER_RESULT_GRACE_MS, ...rest } = p;
  const budget = p.options.maxBudgetUsd;
  let prompt = first;
  let options = p.options;
  let total: StreamResult = {
    text: "",
    sessionId: undefined,
    outcome: "error",
    usage: emptyUsage(),
  };
  /** Late messages the previous round handed to this round as its prompt: settled by how this round ended. */
  let resumed: Steer[] = [];
  for (let round = 0; ; round++) {
    const ch = createInputChannel(prompt);
    const unregister = hook.register(ch, { runId, turnId: p.turnId });
    const stop = () => ch.close(true);
    p.ac.signal.addEventListener("abort", stop, { once: true });
    if (p.ac.signal.aborted) stop();
    let held = 0;
    /** A result is held open and the CLI has not answered yet: the silence timer runs. */
    let holding = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const clearGrace = () => {
      if (grace) clearTimeout(grace);
      grace = undefined;
    };
    const armGrace = () => {
      clearGrace();
      grace = setTimeout(() => ch.close(), graceMs);
    };
    let r: StreamResult;
    try {
      r = await consumeStream({
        ...rest,
        prompt: ch.iterable,
        options,
        onMessage: (m) => {
          clearGrace(); // the CLI is alive: it is reading
          if (holding) armGrace(); // still waiting for its answer: the silence bound starts over
          const text = echoText(m);
          const hit = text === undefined ? undefined : ch.echoed(text);
          if (hit) hook.settle(hit, "delivered");
        },
        onResult: (subtype) => {
          // Hold the input open for a steer the CLI has not echoed yet; an error result ends the process anyway.
          clearGrace();
          holding = false;
          if (subtype === "success" && ch.unechoed().length > 0 && held < MAX_STEER_HOLDS) {
            held++;
            holding = true;
            armGrace();
          } else ch.close();
        },
      });
    } finally {
      clearGrace();
      p.ac.signal.removeEventListener("abort", stop);
      unregister(); // from here (synchronous) no owner message can reach this input
    }
    // Late messages this round took as its prompt: read when it succeeded, else the owner is told.
    for (const m of resumed) hook.settle(m, r.outcome === "success" ? "delivered" : "dropped");
    resumed = [];
    const late = ch.late();
    const unread = ch.unechoed();
    ch.close(true);
    for (const s of unread) hook.settle(s, "dropped");
    total = round === 0 ? r : merge(total, r);
    const left = budget === undefined ? undefined : budget - total.usage.costUsd;
    const resumable =
      late.length > 0 &&
      r.outcome === "success" &&
      !!r.sessionId &&
      round < MAX_LATE_RESUMES &&
      !p.ac.signal.aborted &&
      (left === undefined || left > 0);
    if (!resumable) {
      for (const s of late) hook.settle(s, "dropped");
      return total;
    }
    // The late messages are the next turn's prompt in the SAME session (counts toward the same stage budget);
    // they are settled when that round ends (above), not before the model read them.
    resumed = late;
    prompt = late.map((s) => s.text).join("\n\n");
    options = {
      ...p.options,
      resume: r.sessionId,
      ...(left !== undefined && { maxBudgetUsd: left }),
    };
  }
}
