import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BotSession, InboundTurn, RuntimeEvent } from "@friday/core";
import { turnContent } from "./format-turn";
import type { InputQueue } from "./input-queue";
import { mapMessage } from "./map-message";

/** One long-lived SDK streaming session of one bot. */
export class ClaudeSession implements BotSession {
  readonly events: AsyncIterable<RuntimeEvent>;
  private stopped = false;
  /** Resolves when `stop()` is called, so a waiting read ends without waiting for the SDK. */
  private readonly stopSignal: Promise<"stop">;
  private fireStop!: () => void;

  constructor(
    readonly id: string,
    private readonly queue: InputQueue,
    private readonly abort: AbortController,
    private readonly stream: AsyncIterator<SDKMessage>,
    /** Bot id to display name, for turn headers. */
    private readonly names: Record<string, string>,
    /** The bot's scratch dir; files the user sent are copied under its `inbox/`. */
    private readonly scratchDir: string,
  ) {
    this.stopSignal = new Promise((r) => {
      this.fireStop = () => r("stop");
    });
    this.events = this.run();
  }

  /** Feed one turn to the bot. Dropped after `stop()`. */
  send(turn: InboundTurn): void {
    if (this.stopped) return;
    this.queue.push(turnContent(turn, this.names, this.scratchDir));
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
        const r = await Promise.race([this.stream.next(), this.stopSignal]);
        if (r === "stop" || r.done) return;
        for (const e of mapMessage(r.value)) {
          if (e.type !== "turn_end") {
            yield e;
            continue;
          }
          // The SDK reports the running total of this process; the port wants this turn's cost.
          const turnCost = Math.max(0, e.costUsd - this.costSoFar);
          this.costSoFar = Math.max(this.costSoFar, e.costUsd);
          yield { type: "turn_end", costUsd: turnCost };
        }
      }
    } catch (err) {
      if (!this.stopped) throw err;
    }
  }
}
