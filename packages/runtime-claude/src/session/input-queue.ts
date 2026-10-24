import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** What a user message holds: plain text, or content blocks (text and images). */
export type UserContent = SDKUserMessage["message"]["content"];

/** The SDK's streaming prompt: a push queue the session feeds and the SDK consumes. */
export interface InputQueue {
  /** Yields one user message per `push`, in order; ends after `close()` once drained. */
  iterable: AsyncIterable<SDKUserMessage>;
  /** Add a user message. Ignored after `close()`. */
  push(content: UserContent): void;
  /** End the stream (a waiting consumer wakes and finishes). */
  close(): void;
}

/** Create an empty input queue. */
export function createInputQueue(): InputQueue {
  const items: SDKUserMessage[] = [];
  let closed = false;
  /** Wakes the consumer when it waits on an empty queue. */
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  async function* run(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = items.shift();
      if (next) yield next;
      else if (closed) return;
      else await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    iterable: run(),
    push(content) {
      if (closed) return;
      items.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      });
      notify();
    },
    close() {
      closed = true;
      notify();
    },
  };
}
