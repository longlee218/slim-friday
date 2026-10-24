import type {
  AgentRuntime,
  BotRuntimeSpec,
  BotSession,
  InboundTurn,
  RuntimeEvent,
  SteerInput,
} from "../../src";

/** A session the test drives with `emit`, `end` and `fail`. */
export class FakeSession implements BotSession {
  sent: InboundTurn[] = [];
  /** Every steering push, in order. */
  steered: SteerInput[] = [];
  stopped = false;
  private queue: RuntimeEvent[] = [];
  private waiter: ((r: IteratorResult<RuntimeEvent>) => void) | undefined;
  private rejecter: ((e: unknown) => void) | undefined;
  private finished = false;
  private failure: unknown;

  constructor(
    public id: string,
    public spec: BotRuntimeSpec,
  ) {}

  /** Called after each send; a test uses it to script the bot's reply. */
  onSend?: (session: FakeSession, turn: InboundTurn) => void;

  send(turn: InboundTurn): void {
    this.sent.push(turn);
    this.onSend?.(this, turn);
  }
  steer(input: SteerInput): void {
    this.steered.push(input);
  }
  emit(e: RuntimeEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      this.rejecter = undefined;
      w({ value: e, done: false });
    } else this.queue.push(e);
  }
  end(): void {
    this.finished = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  fail(err: unknown): void {
    if (this.rejecter) this.rejecter(err);
    else this.failure = err;
    this.waiter = undefined;
    this.rejecter = undefined;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.end();
  }

  events: AsyncIterable<RuntimeEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const e = this.queue.shift();
        if (e) return Promise.resolve({ value: e, done: false });
        if (this.failure) return Promise.reject(this.failure);
        if (this.finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<RuntimeEvent>>((resolve, reject) => {
          this.waiter = resolve;
          this.rejecter = reject;
        });
      },
    }),
  };
}

/** A runtime that records opens and resumes and hands out FakeSessions. */
export class FakeRuntime implements AgentRuntime {
  opened: FakeSession[] = [];
  resumed: { sessionId: string; session: FakeSession }[] = [];
  /** Every session opened or resumed, in the order it was created. */
  created: FakeSession[] = [];
  private n = 0;
  /** Copied to every new session as its `onSend`. */
  onTurn?: (session: FakeSession, turn: InboundTurn) => void;

  async open(spec: BotRuntimeSpec): Promise<FakeSession> {
    const s = new FakeSession(`s${++this.n}`, spec);
    s.onSend = this.onTurn;
    this.opened.push(s);
    this.created.push(s);
    return s;
  }
  async resume(sessionId: string, spec: BotRuntimeSpec): Promise<FakeSession> {
    const s = new FakeSession(sessionId, spec);
    s.onSend = this.onTurn;
    this.resumed.push({ sessionId, session: s });
    this.created.push(s);
    return s;
  }
  /** The n-th opened session; throws when the test expected one that was never opened. */
  nth(n: number): FakeSession {
    const s = this.opened[n];
    if (!s) throw new Error(`session ${n} was not opened`);
    return s;
  }
  /** The session created last (each run opens or resumes one); throws when none was created. */
  last(): FakeSession {
    const s = this.created.at(-1);
    if (!s) throw new Error("no session was created");
    return s;
  }
  /** Every turn sent into any session, in the order the sessions were created. */
  turns(): InboundTurn[] {
    return this.created.flatMap((s) => s.sent);
  }
  /** Every session created so far: opened ones first, then resumed ones. */
  all(): FakeSession[] {
    return [...this.opened, ...this.resumed.map((r) => r.session)];
  }
}
