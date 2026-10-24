import { CORE_DEFAULTS } from "../config-defaults";
import type { Bot, BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Attachment, Author } from "../domain/message";
import type { WakeIntent } from "../domain/wake";
import type { PermissionGate } from "../permission/permission-gate";
import type { AgentRuntime, BotRuntimeSpec, BotSession } from "../ports/agent-runtime";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { Memory } from "../ports/memory";
import { GROUP_SESSION_KINDS } from "../ports/memory";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import { promptMemory } from "./group-memory";
import { readRulesText } from "./rules-for-turn";
import { RunTracker } from "./run-steps";
import type { SessionScope } from "./session-scope";

/** A background task a bot started, remembered with the conversation that started it. */
export interface TaskInfo {
  description: string;
  conversationId: ConversationId;
  hop: number;
}

/** A message waiting for the bot to finish its current turn. */
export interface QueuedWake {
  /** The stored wake this message belongs to. */
  wakeId: string;
  conversationId: ConversationId;
  sender: Author;
  text: string;
  hop: number;
  intent: WakeIntent;
  handoff?: boolean;
  /** The ticket this wake works on; `rewake` marks the extra wake for an unfinished one. */
  ticketId?: string;
  rewake?: boolean;
  /** Sent again after a restart cut its turn. */
  interrupted?: boolean;
  attachments?: Attachment[];
  /** The message this one replies to (not stored with the wake: a redelivered wake has none). */
  quote?: { author: Author; text: string };
}

/** One open session and what the hub knows about its current work. */
export interface PoolEntry {
  /** Session key: the bot id (direct) or `<botId>@<groupId>` (group). */
  key: string;
  /** The group of a group session; unset for the bot's direct session. */
  groupId?: string;
  /** The bot as shaped for this session's scope. */
  bot: Bot;
  session: BotSession;
  /** Epoch milliseconds of the last send or event. */
  lastActive: number;
  /** A turn was sent and has not ended yet. */
  busy: boolean;
  /** The wake the bot is answering now; none between turns. */
  currentWakeId?: string;
  /** Ticket of the current wake, if it is a ticket wake. */
  currentTicket?: { id: string; rewake: boolean };
  /** Texts the bot said in the current turn, in order (the last one is its answer). */
  turnTexts: string[];
  /** Bots this bot sent an explicit `result` in the current turn. */
  sentResults: Set<BotId>;
  /** The conversation (and chain depth) the bot is answering now. */
  current: { conversationId: ConversationId; hop: number };
  tasks: Map<string, TaskInfo>;
  /** Run steps (thinking, tools, subagents) of the current turn. */
  steps: RunTracker;
  /** Messages that arrived while the bot was busy; one turn at a time keeps each answer with its question. */
  queue: QueuedWake[];
  /** The event pump is running for this session. */
  pumping?: boolean;
  /** Set before a deliberate stop, so the end of the event stream is not reported as a crash. */
  stopping: boolean;
  /** Bot memory text this session was last given: at open, or after a compaction ("" when none). */
  memoryShown: string;
  /** A compaction may have dropped notes saved since `memoryShown`: re-read the memory on the next turn. */
  memoryStale?: boolean;
  /** The owner's SOUL and USER text in the system prompt at open ("" when none); a compaction falls back to it. */
  ownerAtOpen: string;
  /** Owner text this session was last given: at open or in a turn ("" when none). */
  ownerShown: string;
  /** The rules text in the system prompt at open ("" when none); a compaction falls back to it. */
  rulesAtOpen: string;
  /** Bot rules text this session was last given: at open or in a turn ("" when none). */
  rulesShown: string;
  /** Group rules text last sent to this session, by group; a compaction sets each to `RULES_COMPACTED`. */
  groupRulesSent: Map<string, string>;
  /** Group memory text last sent to this session, by group; a new session starts empty. */
  groupMemorySent: Map<string, string>;
  /** Group context text last sent to this session, by group. */
  groupContextSent: Map<string, string>;
  /** Epoch milliseconds the session was opened or resumed. */
  openedAt: number;
  /** Conversations this session answered (reported when it closes for being quiet). */
  conversations: Set<ConversationId>;
}

/** Open sessions, one per bot and scope (direct, or one group). Opens a new session or resumes the stored one. */
export class SessionPool {
  /** Open sessions by session key. */
  private entries = new Map<string, PoolEntry>();
  /** Sessions being opened, by session key, with their bot (so a stop can wait for them). */
  private opening = new Map<string, { botId: BotId; pending: Promise<PoolEntry> }>();

  constructor(
    private runtime: AgentRuntime,
    private store: Store,
    private clock: Clock,
    private gate: PermissionGate,
    private memory?: Memory,
    /** Cap of the bot memory in the system prompt, and where a too-large memory is reported. */
    private memoryOpts: {
      memoryPromptChars: number;
      log?: Log;
      /** Where a bot's questions go; without it a bot cannot ask. */
      surface?: Surface;
      /** How long a question card waits for the owner. */
      approvalTimeoutMs?: number;
    } = {
      memoryPromptChars: CORE_DEFAULTS.memoryPromptChars,
    },
  ) {}

  /** The scope's open session, creating (or resuming) it when needed. */
  get(scope: SessionScope): Promise<PoolEntry> {
    const open = this.entries.get(scope.key);
    if (open) return Promise.resolve(open);
    let pending = this.opening.get(scope.key)?.pending;
    if (!pending) {
      pending = this.create(scope).finally(() => this.opening.delete(scope.key));
      this.opening.set(scope.key, { botId: scope.bot.id, pending });
    }
    return pending;
  }

  /** The open session with this key. */
  entry(key: string): PoolEntry | undefined {
    return this.entries.get(key);
  }

  /** Every open session of one bot (direct and group ones). */
  entriesOf(botId: BotId): PoolEntry[] {
    return this.list().filter((e) => e.bot.id === botId);
  }

  list(): PoolEntry[] {
    return [...this.entries.values()];
  }

  /** Wait until the sessions being opened (of one bot, or all) are open or have failed. */
  async settled(botId?: BotId): Promise<void> {
    const pending = [...this.opening.values()]
      .filter((o) => botId === undefined || o.botId === botId)
      .map((o) => o.pending);
    await Promise.allSettled(pending);
  }

  /** Forget a session (the stored session id stays, so the next message resumes it). */
  remove(key: string): void {
    this.entries.delete(key);
  }

  private async create(scope: SessionScope): Promise<PoolEntry> {
    const { bot } = scope;
    const ref: { entry?: PoolEntry } = {};
    const spec: BotRuntimeSpec = {
      bot,
      sessionKey: scope.key,
      ...(scope.groupId && { groupId: scope.groupId }),
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
      // A question goes to the conversation the bot answers now; between turns nobody is asked (null).
      ask: async (card) => {
        const conversationId = ref.entry?.busy ? ref.entry.current.conversationId : "";
        if (!conversationId || !this.memoryOpts.surface) return null;
        return this.memoryOpts.surface.askQuestion(conversationId, {
          ...card,
          botId: bot.id,
          botName: bot.name,
          timeoutMs: this.memoryOpts.approvalTimeoutMs ?? CORE_DEFAULTS.approvalTimeoutMs,
        });
      },
      effortControl: {},
      currentConversation: () => (ref.entry?.busy ? ref.entry.current.conversationId : undefined),
    };
    // A memory that cannot be read must not keep the bot from answering.
    const memory = await promptMemory(
      this.memory,
      { kind: "bot", botId: bot.id },
      this.memoryOpts.memoryPromptChars,
      this.memoryOpts.log,
      // A group session gets only the bot's rules and lessons: its facts may come from the owner's direct chat.
      scope.groupId ? GROUP_SESSION_KINDS : undefined,
    );
    if (memory?.trim()) spec.memory = memory;
    const rules = await readRulesText(
      this.memory,
      { kind: "bot", botId: bot.id },
      this.memoryOpts.log,
    );
    if (rules) spec.rules = rules;
    const stored = await this.store.sessions.get(scope.key);
    let session: BotSession | undefined;
    if (stored) {
      try {
        session = await this.runtime.resume(stored, spec);
      } catch {
        // The stored session is gone or unreadable: forget it and start a fresh one.
        await this.store.sessions.clear(scope.key);
      }
    }
    session ??= await this.runtime.open(spec);
    await this.store.sessions.set(scope.key, session.id);
    const entry: PoolEntry = {
      key: scope.key,
      ...(scope.groupId && { groupId: scope.groupId }),
      bot,
      session,
      lastActive: this.clock.now(),
      busy: false,
      current: { conversationId: "", hop: 0 },
      tasks: new Map(),
      steps: new RunTracker(),
      turnTexts: [],
      sentResults: new Set(),
      queue: [],
      stopping: false,
      memoryShown: spec.memory ?? "",
      ownerAtOpen: bot.ownerPreface ?? "",
      ownerShown: bot.ownerPreface ?? "",
      rulesAtOpen: spec.rules ?? "",
      rulesShown: spec.rules ?? "",
      groupRulesSent: new Map(),
      groupMemorySent: new Map(),
      groupContextSent: new Map(),
      openedAt: this.clock.now(),
      conversations: new Set(),
    };
    ref.entry = entry;
    this.entries.set(scope.key, entry);
    return entry;
  }
}
