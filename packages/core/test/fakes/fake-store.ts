import type {
  AuditEntry,
  Bot,
  BotId,
  Conversation,
  ConversationId,
  FileRow,
  Grant,
  Group,
  GroupId,
  IndexedMessage,
  Store,
  StoredMessage,
  Ticket,
  TicketComment,
  UploadRow,
  WakeRow,
} from "../../src";

/** An in-memory Store; tests seed `bots`, `groups` and `convs` directly. */
export class FakeStore implements Store {
  botMap = new Map<BotId, Bot>();
  groupMap = new Map<string, Group>();
  convMap = new Map<ConversationId, Conversation>();
  msgs: StoredMessage[] = [];
  grantList: Grant[] = [];
  sessionMap = new Map<string, string>();
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
    list: async () => [...this.convMap.values()],
    deleteLegacy: async () => {
      const old = [...this.convMap.keys()].filter((id) => !/^(bot|group):/.test(id));
      for (const id of old) this.convMap.delete(id);
      // Messages keep their position (ids are indexes), so blank the old ones out.
      this.msgs = this.msgs.map((m) => (old.includes(m.conversationId) ? undefined : m)) as never;
      return old.length;
    },
  };
  /** Message ids are positions (1-based) in `msgs`; a deleted one leaves a hole. */
  private live(): IndexedMessage[] {
    return this.msgs.flatMap((m, i) => (m ? [{ ...m, id: i + 1 }] : []));
  }
  messages = {
    append: async (m: StoredMessage) => this.msgs.push(m),
    get: async (id: number) => this.live().find((m) => m.id === id),
    page: async (c: ConversationId, f: { before?: number; limit: number }) =>
      this.live()
        .filter((m) => m.conversationId === c && (f.before === undefined || m.id < f.before))
        .reverse()
        .slice(0, f.limit),
    recent: async (c: ConversationId, limit: number) =>
      this.msgs.filter((m) => m?.conversationId === c).slice(-limit),
    after: async (afterId: number, limit: number) =>
      this.live()
        .filter((m) => m.id > afterId)
        .slice(0, limit),
  };
  fileMap = new Map<string, FileRow>();
  files = {
    insert: async (f: FileRow) => {
      this.fileMap.set(f.id, { ...f });
    },
    get: async (id: string) => this.fileMap.get(id),
    delete: async (id: string) => {
      this.fileMap.delete(id);
    },
  };
  uploadMap = new Map<string, UploadRow>();
  uploads = {
    insert: async (u: UploadRow) => {
      this.uploadMap.set(u.id, { ...u });
    },
    get: async (id: string) => this.uploadMap.get(id),
    markUsed: async (id: string, messageId: number | null) => {
      const u = this.uploadMap.get(id);
      if (u) Object.assign(u, { state: "used", messageId: messageId ?? undefined });
    },
    claim: async (id: string) => {
      const u = this.uploadMap.get(id);
      if (u?.state !== "pending") return false;
      u.state = "claimed";
      return true;
    },
    release: async (id: string) => {
      const u = this.uploadMap.get(id);
      if (u?.state === "claimed") u.state = "pending";
    },
    pendingBefore: async (at: number) =>
      [...this.uploadMap.values()]
        .filter((u) => u.state !== "used" && u.at < at)
        .sort((a, b) => a.at - b.at),
    delete: async (id: string) => {
      this.uploadMap.delete(id);
    },
  };
  readMap = new Map<ConversationId, number>();
  reads = {
    get: async (c: ConversationId) => this.readMap.get(c) ?? 0,
    set: async (c: ConversationId, messageId: number) => {
      this.readMap.set(c, Math.max(this.readMap.get(c) ?? 0, messageId));
    },
    unread: async (c: ConversationId) =>
      this.live().filter(
        (m) =>
          m.conversationId === c && m.id > (this.readMap.get(c) ?? 0) && m.author.kind !== "user",
      ).length,
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
    get: async (key: string) => this.sessionMap.get(key),
    set: async (key: string, id: string) => {
      this.sessionMap.set(key, id);
    },
    clear: async (key: string) => {
      this.sessionMap.delete(key);
    },
    clearBot: async (botId: BotId) => {
      for (const k of [...this.sessionMap.keys()])
        if (k === botId || k.startsWith(`${botId}@`)) this.sessionMap.delete(k);
    },
    clearGroup: async (groupId: GroupId) => {
      for (const k of [...this.sessionMap.keys()])
        if (k.endsWith(`@${groupId}`)) this.sessionMap.delete(k);
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
