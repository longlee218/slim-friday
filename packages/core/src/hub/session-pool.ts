import type { Bot, BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Attachment, Author } from "../domain/message";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Memory } from "../ports/memory";
import type { Store } from "../ports/store";

/** A background task a bot started, remembered with the conversation that started it. */
export interface TaskInfo {
  description: string;
  conversationId: ConversationId;
  hop: number;
}

/** A message waiting for the bot to finish its current turn. */
export interface QueuedWake {
  conversationId: ConversationId;
  sender: Author;
  text: string;
  hop: number;
  attachments?: Attachment[];
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
  /** Messages that arrived while the bot was busy; one turn at a time keeps each answer with its question. */
  queue: QueuedWake[];
  /** The event pump is running for this session. */
  pumping?: boolean;
  /** Set before a deliberate stop, so the end of the event stream is not reported as a crash. */
  stopping: boolean;
  /** Group memory text last sent to this session, by group; a new session starts empty. */
  groupMemorySent: Map<string, string>;
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
    private memory?: Memory,
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
        if (!conversationId)
          return Promise.resolve({ behavior: "deny", reason: "no conversation to ask in" });
        // A tool resolves "group" scope from the conversation the bot answers now; a task started elsewhere must not
        // reach that group.
        if (c.taskId && c.input.scope === "group" && conversationId !== e?.current.conversationId)
          return Promise.resolve({
            behavior: "deny",
            reason: "group scope is not reachable from a task started in another conversation",
          });
        return this.gate.decide(
          { tool: c.tool, input: c.input, botId: bot.id, conversationId },
          bot.name,
        );
      },
      effortControl: {},
      currentConversation: () => (ref.entry?.busy ? ref.entry.current.conversationId : undefined),
    };
    // A memory that cannot be read must not keep the bot from answering.
    const memory = await this.memory?.read({ kind: "bot", botId: bot.id }).catch(() => "");
    if (memory?.trim()) spec.memory = memory;
    const stored = await this.store.sessions.get(bot.id);
    let session: BotSession | undefined;
    if (stored) {
      try {
        session = await this.runtime.resume(stored, spec);
      } catch {
        // The stored session is gone or unreadable: forget it and start a fresh one.
        await this.store.sessions.clear(bot.id);
      }
    }
    session ??= await this.runtime.open(spec);
    await this.store.sessions.set(bot.id, session.id);
    const entry: PoolEntry = {
      bot,
      session,
      lastActive: this.clock.now(),
      busy: false,
      current: { conversationId: "", hop: 0 },
      tasks: new Map(),
      queue: [],
      stopping: false,
      groupMemorySent: new Map(),
    };
    ref.entry = entry;
    this.entries.set(bot.id, entry);
    return entry;
  }
}
