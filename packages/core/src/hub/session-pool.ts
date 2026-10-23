import type { Bot, BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";

/** A background task a bot started, remembered with the conversation that started it. */
export interface TaskInfo {
  description: string;
  conversationId: ConversationId;
  hop: number;
}

/** One open session and what the hub knows about its current work. */
export interface PoolEntry {
  bot: Bot;
  session: BotSession;
  /** Epoch milliseconds of the last send or event. */
  lastActive: number;
  /** A turn was sent and has not ended yet. */
  busy: boolean;
  /** The conversation (and chain depth) the bot is answering now. */
  current: { conversationId: ConversationId; hop: number };
  tasks: Map<string, TaskInfo>;
  /** The event pump is running for this session. */
  pumping?: boolean;
  /** Set before a deliberate stop, so the end of the event stream is not reported as a crash. */
  stopping: boolean;
}

/** Open sessions, one per bot. Opens a new session or resumes the stored one. */
export class SessionPool {
  private entries = new Map<BotId, PoolEntry>();
  private opening = new Map<BotId, Promise<PoolEntry>>();

  constructor(
    private runtime: AgentRuntime,
    private store: Store,
    private clock: Clock,
    private gate: PermissionGate,
  ) {}

  /** The bot's open session, creating (or resuming) it when needed. */
  get(bot: Bot): Promise<PoolEntry> {
    const open = this.entries.get(bot.id);
    if (open) return Promise.resolve(open);
    let pending = this.opening.get(bot.id);
    if (!pending) {
      pending = this.create(bot).finally(() => this.opening.delete(bot.id));
      this.opening.set(bot.id, pending);
    }
    return pending;
  }

  entry(botId: BotId): PoolEntry | undefined {
    return this.entries.get(botId);
  }

  list(): PoolEntry[] {
    return [...this.entries.values()];
  }

  /** Forget a session (the stored session id stays, so the next message resumes it). */
  remove(botId: BotId): void {
    this.entries.delete(botId);
  }

  private async create(bot: Bot): Promise<PoolEntry> {
    const ref: { entry?: PoolEntry } = {};
    const spec: BotRuntimeSpec = {
      bot,
      // A task's call is asked in the conversation that started the task; any other call in the current one.
      decide: (c) => {
        const e = ref.entry;
        const conversationId =
          (c.taskId ? e?.tasks.get(c.taskId)?.conversationId : undefined) ??
          e?.current.conversationId ??
          "";
        return this.gate.decide(
          { tool: c.tool, input: c.input, botId: bot.id, conversationId },
          bot.name,
        );
      },
    };
    const stored = await this.store.sessions.get(bot.id);
    const session = stored
      ? await this.runtime.resume(stored, spec)
      : await this.runtime.open(spec);
    await this.store.sessions.set(bot.id, session.id);
    const entry: PoolEntry = {
      bot,
      session,
      lastActive: this.clock.now(),
      busy: false,
      current: { conversationId: "", hop: 0 },
      tasks: new Map(),
      stopping: false,
    };
    ref.entry = entry;
    this.entries.set(bot.id, entry);
    return entry;
  }
}
