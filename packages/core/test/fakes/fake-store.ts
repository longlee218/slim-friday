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
  conversations = { get: async (id: ConversationId) => this.convMap.get(id) };
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
}
