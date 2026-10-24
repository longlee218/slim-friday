import type {
  AuditEntry,
  Bot,
  BotId,
  CardRow,
  Conversation,
  ConversationId,
  FileRow,
  Grant,
  Group,
  GroupId,
  IndexedMessage,
  ScopeState,
  SteeringRow,
  Store,
  StoredMessage,
  Ticket,
  TicketComment,
  UploadRow,
  WakeCursor,
  WakeRow,
  WakeStatus,
} from "../../src";

/** Statuses of a wake not finished yet. */
const ACTIVE_STATUSES: WakeStatus[] = ["queued", "leased", "running", "waiting_input"];

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
  /** Message ids by `<conversation>\0<nonce>`. */
  private nonces = new Map<string, number>();
  messages = {
    append: async (m: StoredMessage) => this.msgs.push(m),
    appendOnce: async (m: StoredMessage, clientNonce: string) => {
      const k = `${m.conversationId}\u0000${clientNonce}`;
      const first = this.nonces.get(k);
      if (first !== undefined) return { id: first, replayed: true };
      const id = this.msgs.push(m);
      this.nonces.set(k, id);
      return { id, replayed: false };
    },
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
  /** Copies of the rows that match, ordered by creation time then id, after the cursor, at most `limit`. */
  private wakesAfter = (f: (w: WakeRow) => boolean, limit: number, after?: WakeCursor) =>
    [...this.wakeMap.values()]
      .filter(f)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .filter(
        (w) =>
          !after ||
          w.createdAt > after.createdAt ||
          (w.createdAt === after.createdAt && w.id > after.id),
      )
      .slice(0, limit)
      .map((w) => ({ ...w }));
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
    waiting: async () =>
      [...this.wakeMap.values()]
        .filter((w) => w.status === "waiting_input")
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
        if (!ACTIVE_STATUSES.includes(w.status) && (w.endedAt ?? w.createdAt) < at) {
          this.wakeMap.delete(id);
          n++;
        }
      return n;
    },
    pendingOutcomes: async (limit: number, after?: WakeCursor) =>
      this.wakesAfter(
        (w) =>
          ["done", "failed", "interrupted", "cancelled", "expired", "dropped"].includes(w.status) &&
          w.outcomeReturnedAt === undefined &&
          w.sender.kind === "bot" &&
          (w.intent === "request" || w.intent === "question") &&
          !w.handoff,
        limit,
        after,
      ),
    staleHeld: async (holdUntil: number, before: number, limit: number, after?: WakeCursor) =>
      this.wakesAfter(
        (w) => w.status === "queued" && w.wakeAt === holdUntil && w.createdAt < before,
        limit,
        after,
      ),
    insertDeduped: async (w: WakeRow) => {
      const existing =
        w.dedupeKey == null
          ? undefined
          : [...this.wakeMap.values()].find(
              (x) => x.conversationId === w.conversationId && x.dedupeKey === w.dedupeKey,
            );
      if (existing) return { inserted: false as const, existing: { ...existing } };
      this.wakeMap.set(w.id, { ...w });
      return { inserted: true as const };
    },
    // Same rules as the db claim, single process.
    claimNext: async (o: { owner: string; bootId: string; now: number; leaseMs: number }) => {
      const all = [...this.wakeMap.values()];
      const held = (w: WakeRow) => w.status === "leased" || w.status === "running";
      const ok = (w: WakeRow) =>
        w.status === "queued"
          ? (w.wakeAt == null || w.wakeAt <= o.now) &&
            !all.some((x) => x.scopeKey === w.scopeKey && held(x))
          : held(w) &&
            ((w.leaseExpiresAt != null && w.leaseExpiresAt <= o.now) ||
              !w.leaseOwner?.startsWith(`${o.bootId}:`));
      const rank = (w: WakeRow) => (w.priority === "interactive" ? 0 : 1);
      const row = all
        .filter(ok)
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            a.createdAt - b.createdAt ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )[0];
      if (!row) return undefined;
      const claimedFrom = row.status;
      Object.assign(row, {
        status: "leased",
        leaseOwner: o.owner,
        leaseFence: row.leaseFence + 1,
        leaseExpiresAt: o.now + o.leaseMs,
      });
      return { ...row, claimedFrom };
    },
    transition: async (id: string, fence: number, from: WakeStatus[], patch: Partial<WakeRow>) => {
      const w = this.wakeMap.get(id);
      if (!w || w.leaseFence !== fence || !from.includes(w.status)) return false;
      Object.assign(w, patch);
      return true;
    },
    renew: async (id: string, owner: string, fence: number, until: number) => {
      const w = this.wakeMap.get(id);
      if (!w || w.leaseOwner !== owner || w.leaseFence !== fence) return false;
      if (w.status !== "leased" && w.status !== "running") return false;
      w.leaseExpiresAt = until;
      return true;
    },
    activeInScope: async (scopeKey: string) =>
      [...this.wakeMap.values()]
        .filter(
          (w) =>
            w.scopeKey === scopeKey &&
            ["queued", "leased", "running", "waiting_input"].includes(w.status),
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((w) => ({ ...w })),
  };
  /** Attempts by id, for assertions. */
  attemptMap = new Map<string, Record<string, unknown>>();
  attempts = {
    start: async (a: {
      id: string;
      wakeId: string;
      fence: number;
      owner: string;
      startedAt: number;
    }) => {
      this.attemptMap.set(a.id, { ...a, status: "running" });
    },
    finish: async (
      id: string,
      status: "done" | "failed" | "interrupted" | "parked" | "setup_failed",
      at: number,
      error?: string,
    ) => {
      const a = this.attemptMap.get(id);
      // The first close wins, as in the db.
      if (a?.status !== "running") return;
      Object.assign(a, {
        status,
        endedAt: at,
        ...(error !== undefined && { error }),
      });
    },
  };
  /** Steering rows by id. */
  steerMap = new Map<string, SteeringRow>();
  private steerRows = (f: (r: SteeringRow) => boolean) =>
    [...this.steerMap.values()]
      .filter(f)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  steering = {
    add: async (r: SteeringRow) => {
      if (!this.steerMap.has(r.id)) this.steerMap.set(r.id, { ...r });
    },
    bound: async (wakeId: string) =>
      this.steerRows((r) => r.wakeId === wakeId && r.claimedAt === undefined).map((r) => ({
        ...r,
      })),
    remove: async (ids: string[]) => {
      for (const id of ids) this.steerMap.delete(id);
    },
    claim: async (wakeId: string, at: number) =>
      this.steerRows((r) => r.wakeId === wakeId && r.claimedAt === undefined).map((r) => {
        r.claimedAt = at;
        return { ...r };
      }),
    held: async (scopeKey: string) =>
      this.steerRows((r) => r.scopeKey === scopeKey && r.wakeId === undefined).map((r) => ({
        ...r,
      })),
    bind: async (ids: string[], wakeId: string) => {
      const bound: string[] = [];
      for (const id of ids) {
        const r = this.steerMap.get(id);
        if (r && r.wakeId === undefined && r.claimedAt === undefined) {
          r.wakeId = wakeId;
          bound.push(id);
        }
      }
      return bound;
    },
    deleteClaimed: async (wakeId: string) => {
      for (const r of this.steerRows((r) => r.wakeId === wakeId && r.claimedAt !== undefined))
        this.steerMap.delete(r.id);
    },
    unbind: async (wakeId: string) => {
      for (const r of this.steerRows((r) => r.wakeId === wakeId && r.claimedAt === undefined))
        delete r.wakeId;
    },
    releaseClaimed: async (wakeId: string) => {
      for (const r of this.steerRows((r) => r.wakeId === wakeId && r.claimedAt !== undefined))
        r.claimedAt = undefined;
    },
    deleteForScope: async (scopeKey: string) => {
      for (const r of this.steerRows((r) => r.scopeKey === scopeKey)) this.steerMap.delete(r.id);
    },
    endedRuns: async (limit: number, after?: string) => {
      const ended = ["done", "failed", "interrupted", "cancelled", "blocked", "dropped", "expired"];
      const ids = new Set<string>();
      for (const r of this.steerMap.values()) {
        const status = r.wakeId ? this.wakeMap.get(r.wakeId)?.status : undefined;
        if (r.wakeId && status && ended.includes(status) && (!after || r.wakeId > after))
          ids.add(r.wakeId);
      }
      return [...ids].sort().slice(0, limit);
    },
    heldScopes: async (limit: number, after?: string) =>
      [
        ...new Set(
          [...this.steerMap.values()]
            .filter((r) => r.wakeId === undefined && (!after || r.scopeKey > after))
            .map((r) => r.scopeKey),
        ),
      ]
        .sort()
        .slice(0, limit),
  };
  /** Cards by id. */
  cardMap = new Map<string, CardRow>();
  private cardRows = (f: (c: CardRow) => boolean) =>
    [...this.cardMap.values()]
      .filter(f)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((c) => ({ ...c }));
  cards = {
    insert: async (c: CardRow) => {
      this.cardMap.set(c.id, { ...c });
    },
    insertIfNoneOpen: async (group: CardRow[]) => {
      const wakeId = group[0]?.wakeId;
      if (wakeId === undefined) return false;
      if ([...this.cardMap.values()].some((c) => c.wakeId === wakeId && c.status === "open"))
        return false;
      for (const c of group) this.cardMap.set(c.id, { ...c });
      return true;
    },
    get: async (id: string) => {
      const c = this.cardMap.get(id);
      return c && { ...c };
    },
    open: async () => this.cardRows((c) => c.status === "open"),
    openForScope: async (scopeKey: string) =>
      this.cardRows((c) => c.status === "open" && c.scopeKey === scopeKey),
    answer: async (id: string, answer: CardRow["answer"], at: number, messageId?: number) => {
      const c = this.cardMap.get(id);
      if (c?.status !== "open") return false;
      Object.assign(c, {
        status: "answered",
        answer,
        answeredAt: at,
        ...(messageId !== undefined && { answeredMessageId: messageId }),
      });
      return true;
    },
    forWake: async (wakeId: string) => this.cardRows((c) => c.wakeId === wakeId),
    answeredByMessage: async (messageId: number) =>
      this.cardRows((c) => c.answeredMessageId === messageId),
    setStatus: async (id: string, from: CardRow["status"], to: CardRow["status"]) => {
      const c = this.cardMap.get(id);
      if (c?.status !== from) return false;
      c.status = to;
      return true;
    },
    markReminded: async (id: string, at: number) => {
      const c = this.cardMap.get(id);
      if (c) c.remindedAt = at;
    },
  };
  /** Effect records by key. */
  effectMap = new Map<string, { state: "started" | "done"; result?: string }>();
  effects = {
    begin: async (key: string, _wakeId: string, _tool: string, _at: number) => {
      const e = this.effectMap.get(key);
      if (!e) {
        this.effectMap.set(key, { state: "started" });
        return { state: "new" as const };
      }
      return e.state === "done"
        ? { state: "done" as const, result: e.result ?? "" }
        : { state: "started" as const };
    },
    finish: async (key: string, result: string, _at: number) => {
      const e = this.effectMap.get(key);
      if (e?.state === "started") Object.assign(e, { state: "done", result });
    },
  };
  /** Scope state by key. */
  scopeMap = new Map<string, ScopeState>();
  /** Create-or-patch, like the repo's upsert. */
  private scopeSet(key: string, patch: Partial<ScopeState>) {
    this.scopeMap.set(key, { resetPending: false, ...this.scopeMap.get(key), ...patch });
  }
  scopes = {
    get: async (key: string) => {
      const s = this.scopeMap.get(key);
      return s && { ...s };
    },
    setEffort: async (key: string, effort: string) => this.scopeSet(key, { effort }),
    markReset: async (key: string) => this.scopeSet(key, { resetPending: true }),
    clearReset: async (key: string) => this.scopeSet(key, { resetPending: false }),
    finished: async (key: string, at: number, startedAt: number) =>
      this.scopeSet(key, {
        lastFinishedAt: at,
        lastFlushedAt: this.scopeMap.get(key)?.lastFlushedAt ?? startedAt,
      }),
    clearEffort: async (key: string) => {
      const s = this.scopeMap.get(key);
      if (s) delete s.effort;
    },
    flushed: async (key: string, at: number) => this.scopeSet(key, { lastFlushedAt: at }),
    quiet: async (before: number) =>
      [...this.scopeMap.entries()]
        .filter(
          ([, s]) =>
            s.lastFinishedAt !== undefined &&
            s.lastFinishedAt < before &&
            (s.lastFlushedAt === undefined || s.lastFlushedAt < s.lastFinishedAt),
        )
        .map(([k]) => k),
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
