import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../src/session/build-options";

/** A scripted SDK `query`: the test pushes messages out and reads what the session sent in. */
export interface FakeQuery {
  /** Drop-in for the SDK `query`. */
  queryFn: QueryFn;
  /** Emit one message from the SDK to the session. */
  emit(m: unknown): void;
  /** End the SDK stream normally. */
  end(): void;
  /** Make the SDK stream throw. */
  fail(err: Error): void;
  /** Options the session passed to `query`. */
  options(): Options;
  /** Texts of the user messages the session fed in so far (drained in the background). */
  sent(): string[];
}

/** Build a fake `query` for one session. */
export function fakeQuery(): FakeQuery {
  const buffered: Array<IteratorResult<SDKMessage> | Error> = [];
  let waiting:
    | { resolve: (r: IteratorResult<SDKMessage>) => void; reject: (e: Error) => void }
    | undefined;
  let opts: Options | undefined;
  const sent: string[] = [];

  const push = (item: IteratorResult<SDKMessage> | Error) => {
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      if (item instanceof Error) w.reject(item);
      else w.resolve(item);
    } else buffered.push(item);
  };

  const queryFn = ((args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    opts = args.options;
    // Drain what the session feeds in, like the SDK does.
    void (async () => {
      for await (const m of args.prompt)
        sent.push(String((m.message as { content: unknown }).content));
    })();
    const it: AsyncGenerator<SDKMessage> = {
      next: () => {
        const b = buffered.shift();
        if (b instanceof Error) return Promise.reject(b);
        if (b) return Promise.resolve(b);
        return new Promise((resolve, reject) => {
          waiting = { resolve, reject };
        });
      },
      return: async () => ({ done: true, value: undefined }),
      throw: async (e) => {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: async () => {},
    };
    return Object.assign(it, { interrupt: async () => {} });
  }) as unknown as QueryFn;

  return {
    queryFn,
    emit: (m) => push({ done: false, value: m as SDKMessage }),
    end: () => push({ done: true, value: undefined }),
    fail: (err) => push(err),
    options: () => opts as Options,
    sent: () => [...sent],
  };
}
