import type {
  AuditEntry,
  Bot,
  BotId,
  Conversation,
  ConversationId,
  Grant,
  Group,
  Store,
  StoredMessage,
  Ticket,
  TicketComment,
  WakeRow,
} from "../../src";

/** An in-memory Store; tests seed `bots`, `groups` and `convs` directly. */
export class FakeStore implements Store {
  botMap = new Map<BotId, Bot>();
  groupMap = new Map<string, Group>();
  convMap = new Map<ConversationId, Conversation>();
  msgs: StoredMessage[] = [];
  grantList: Grant[] = [];
  sessionMap = new Map<BotId, string>();
  spendMap = new Map<string, number>();
  auditLog: AuditEntry[] = [];

  bots = {
    get: async (id: BotId) => this.botMap.get(id),
    list: async () => [...this.botMap.values()],
  };
  groups = { get: async (id: string) => this.groupMap.get(id) };
  conversations = {
    get: async (id: ConversationId) => this.convMap.get(id),
    direct: async (botId: BotId) =>
      [...this.convMap.values()].find((c) => c.kind === "direct" && c.botId === botId),
  };
  messages = {
    append: async (m: StoredMessage) => {
      this.msgs.push(m);
    },
    recent: async (c: ConversationId, limit: number) =>
      this.msgs.filter((m) => m.conversationId === c).slice(-limit),
  };
  grants = {
    list: async (botId: BotId) =>
      this.grantList.filter((g) => g.botId === botId || g.botId === "*"),
    add: async (g: Grant) => {
      this.grantList.push(g);
    },
    revoke: async (id: string) => {
      this.grantList = this.grantList.filter((g) => g.id !== id);
    },
  };
  sessions = {
    get: async (botId: BotId) => this.sessionMap.get(botId),
    set: async (botId: BotId, id: string) => {
      this.sessionMap.set(botId, id);
    },
    clear: async (botId: BotId) => {
      this.sessionMap.delete(botId);
    },
  };
  spend = {
    add: async (botId: BotId, day: string, usd: number) => {
      const k = `${botId}|${day}`;
      this.spendMap.set(k, (this.spendMap.get(k) ?? 0) + usd);
    },
    total: async (botId: BotId, day: string) => this.spendMap.get(`${botId}|${day}`) ?? 0,
  };
  audit = {
    append: async (e: AuditEntry) => {
      this.auditLog.push(e);
    },
  };
  wakeMap = new Map<string, WakeRow>();
  wakes = {
    insert: async (w: WakeRow) => {
      this.wakeMap.set(w.id, { ...w });
    },
    update: async (id: string, patch: Partial<Omit<WakeRow, "id">>) => {
      const w = this.wakeMap.get(id);
      if (w) Object.assign(w, patch);
    },
    get: async (id: string) => this.wakeMap.get(id),
    open: async () =>
      [...this.wakeMap.values()]
        .filter((w) => w.status === "queued" || w.status === "running")
        .sort((a, b) => a.createdAt - b.createdAt),
    botSentSince: async (conversationId: ConversationId, since: number) =>
      [...this.wakeMap.values()]
        .filter(
          (w) =>
            w.sender.kind === "bot" && w.conversationId === conversationId && w.createdAt >= since,
        )
        .sort((a, b) => a.createdAt - b.createdAt),
    deleteFinishedBefore: async (at: number) => {
      let n = 0;
      for (const [id, w] of this.wakeMap)
        if (w.status !== "queued" && w.status !== "running" && (w.endedAt ?? w.createdAt) < at) {
          this.wakeMap.delete(id);
          n++;
        }
      return n;
    },
  };
  ticketMap = new Map<string, Ticket>();
  ticketComments: TicketComment[] = [];
  private lastTicketNumber = 0;
  private nextId = 0;
  tickets = {
    create: async (t: Omit<Ticket, "id" | "number" | "updatedAt" | "completedAt">) => {
      const done = t.status === "done" || t.status === "closed";
      const ticket: Ticket = {
        ...t,
        id: `t${++this.nextId}`,
        number: ++this.lastTicketNumber,
        updatedAt: t.createdAt,
        ...(done && { completedAt: t.createdAt }),
      };
      this.ticketMap.set(ticket.id, ticket);
      return { ...ticket };
    },
    // Copies, like a db read: a caller holding a ticket does not see later updates.
    get: async (id: string) => {
      const t = this.ticketMap.get(id);
      return t && { ...t };
    },
    getByNumber: async (n: number) => {
      const t = [...this.ticketMap.values()].find((x) => x.number === n);
      return t && { ...t };
    },
    list: async (f: {
      status?: Ticket["status"];
      excludeClosed?: boolean;
      assigneeBotId?: BotId;
      before?: { createdAt: number; id: string };
      limit: number;
    }) =>
      [...this.ticketMap.values()]
        .filter((t) => !f.status || t.status === f.status)
        .filter((t) => !f.excludeClosed || t.status !== "closed")
        .filter((t) => !f.assigneeBotId || t.assigneeBotId === f.assigneeBotId)
        .filter(
          (t) =>
            !f.before ||
            t.createdAt < f.before.createdAt ||
            (t.createdAt === f.before.createdAt && t.id < f.before.id),
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, f.limit),
    update: async (
      id: string,
      patch: Partial<
        Pick<Ticket, "title" | "description" | "status" | "priority" | "assigneeBotId">
      >,
      now: number,
    ) => {
      const t = this.ticketMap.get(id);
      if (!t) return undefined;
      Object.assign(t, patch, { updatedAt: now });
      if (t.status === "done" || t.status === "closed") t.completedAt = t.completedAt ?? now;
      else t.completedAt = undefined;
      return { ...t };
    },
    addComment: async (c: Omit<TicketComment, "id">) => {
      const comment = { id: `c${++this.nextId}`, ...c };
      this.ticketComments.push(comment);
      const t = this.ticketMap.get(c.ticketId);
      if (t) t.updatedAt = Math.max(t.updatedAt, c.createdAt);
      return comment;
    },
    comments: async (ticketId: string) =>
      this.ticketComments
        .filter((c) => c.ticketId === ticketId)
        .sort((a, b) => a.createdAt - b.createdAt),
  };
}
