import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotSession, InboundTurn, RuntimeEvent, SteerInput } from "@friday/core";
import type { CallGuard } from "./call-guard";
import { turnContent, withAttachments } from "./format-turn";
import type { InputQueue } from "./input-queue";
import { mapMessage } from "./map-message";

/** One long-lived SDK streaming session of one bot. */
export class ClaudeSession implements BotSession {
  readonly events: AsyncIterable<RuntimeEvent>;
  private stopped = false;
  /** Resolves when `stop()` is called, so a waiting read ends without waiting for the SDK. */
  private readonly stopSignal: Promise<"stop">;
  private fireStop!: () => void;
  /** Resolves with the guard text when the call guard stops the run. */
  private readonly guardSignal: Promise<{ guard: string }>;
  private fireGuard!: (text: string) => void;

  constructor(
    readonly id: string,
    private readonly queue: InputQueue,
    private readonly abort: AbortController,
    private readonly stream: AsyncIterator<SDKMessage>,
    /** Bot id to display name, for turn headers. */
    private readonly names: Record<string, string>,
    /** The bot's scratch dir; files the user sent are copied under its `inbox/`. */
    private readonly scratchDir: string,
    /** Loop guard and tool-call cap of this session; its turn count starts over at each turn. */
    private readonly guard?: CallGuard,
  ) {
    this.stopSignal = new Promise((r) => {
      this.fireStop = () => r("stop");
    });
    this.guardSignal = new Promise((r) => {
      this.fireGuard = (text) => r({ guard: text });
    });
    this.events = this.run();
  }

  /** Feed one turn to the bot. Dropped after `stop()`. */
  send(turn: InboundTurn): void {
    if (this.stopped) return;
    this.guard?.resetTurn();
    this.queue.push(turnContent(turn, this.names, this.scratchDir));
  }

  /** The call guard stopped the run (from the `PreToolUse` hook): `events` ends with a `guard_stop` of `text`. */
  guardStop(text: string): void {
    if (!this.stopped) this.fireGuard(text);
  }

  /**
   * Push owner messages into the turn in progress. The SDK reads a message queued while a tool runs at the
   * next model step of the same turn (spike result: one answer, one `result`). Dropped after `stop()`.
   */
  steer(input: SteerInput): void {
    if (this.stopped) return;
    this.queue.push(withAttachments(input.text, input.attachments, this.scratchDir));
  }

  /** End the input, abort the SDK (its background tasks go with it) and end `events`. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.close();
    this.abort.abort();
    this.fireStop();
  }

  /** Running cost total the SDK reported so far (its `total_cost_usd` grows over the session). */
  private costSoFar = 0;

  /** Map SDK messages to events until the stream ends or the session stops; a stream error after a stop is silent. */
  private async *run(): AsyncGenerator<RuntimeEvent> {
    try {
      while (true) {
        const next = this.stream.next();
        // A read the guard or a stop overtook may reject when the SDK aborts: never an unhandled rejection.
        next.catch(() => {});
        const r = await Promise.race([next, this.stopSignal, this.guardSignal]);
        if (r === "stop") return;
        if ("guard" in r) {
          yield { type: "guard_stop", text: r.guard };
          return;
        }
        if (r.done) return;
        for (const e of mapMessage(r.value)) {
          if (e.type !== "turn_end") {
            yield e;
            continue;
          }
          // A turn ended: a follow-up turn (a finished task's) gets a fresh count.
          this.guard?.resetTurn();
          // The SDK reports the running total of this process; the port wants this turn's cost.
          const turnCost = Math.max(0, e.costUsd - this.costSoFar);
          this.costSoFar = Math.max(this.costSoFar, e.costUsd);
          yield { type: "turn_end", costUsd: turnCost };
        }
      }
    } catch (err) {
      // Our own abort (stop, or a park that closes the session) ends the stream as expected, never as a failure;
      // any other error (a foreign abort included) is reported as it is.
      if (!this.stopped && !this.abort.signal.aborted) throw err;
    }
  }
}
