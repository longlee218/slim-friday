import type { CoreLimits } from "../config-defaults";
import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { WakeRow } from "../domain/wake";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";

/** One bot being woken by one message. */
export interface Wake {
  /** Id of the stored wake row being checked; with `createdAt` it orders this wake among the stored rows. */
  id?: string;
  /** Creation time of the stored wake row being checked. */
  createdAt?: number;
  conversationId: ConversationId;
  sender: Author;
  target: BotId;
  text: string;
  /** Hand-offs since the user message that started the chain. */
  hop: number;
}

export type GuardResult = { ok: true } | { ok: false; reason: "hops" | "rate" | "repeat" };

const HOUR_MS = 3_600_000;

/**
 * Stops runaway bot-to-bot chains: too many hops, too many bot messages, or a bot repeating itself.
 * It keeps no state: counts come from the stored wake rows, so every worker process and every restart sees
 * the same numbers. The hub stores a wake before it checks it, so a checked row counts only the rows stored
 * before it, by (createdAt, id) strictly lower: it never counts itself and two simultaneous wakes cannot block
 * each other (the earlier one passes). Without id and createdAt every stored row counts except the one with
 * that id. A row that a cap blocked earlier (`blocked`) was never delivered and is not counted either.
 */
export class ChainGuard {
  constructor(
    private store: Pick<Store, "wakes">,
    private clock: Clock,
    private limits: CoreLimits,
  ) {}

  /** Would this wake be allowed? Async because it reads the stored rows. */
  async check(w: Wake): Promise<GuardResult> {
    if (w.hop > this.limits.maxHops) return { ok: false, reason: "hops" };
    // A user may repeat a message and is not rate limited; only bot senders are capped.
    if (w.sender.kind !== "bot") return { ok: true };
    const now = this.clock.now();
    const rows = await this.store.wakes.botSentSince(
      w.conversationId,
      now - Math.max(HOUR_MS, this.limits.repeatWindowMs),
    );
    const sent = rows.filter((r) => r.status !== "blocked" && this.isBefore(r, w));
    const lastHour = sent.filter((r) => now - r.createdAt < HOUR_MS).length;
    if (lastHour >= this.limits.maxBotMessagesPerConversationPerHour)
      return { ok: false, reason: "rate" };
    const key = this.keyOf(w.conversationId, w.sender, w.target, w.text);
    const repeated = sent.some(
      (r) =>
        now - r.createdAt < this.limits.repeatWindowMs &&
        this.keyOf(r.conversationId, r.sender, r.targetBot, r.text) === key,
    );
    return repeated ? { ok: false, reason: "repeat" } : { ok: true };
  }

  /** Is the stored row `r` ahead of the checked wake `w` (or, when `w` has no position, simply not `w` itself)? */
  private isBefore(r: WakeRow, w: Wake): boolean {
    if (w.id === undefined) return true;
    if (w.createdAt === undefined) return r.id !== w.id;
    return r.createdAt < w.createdAt || (r.createdAt === w.createdAt && r.id < w.id);
  }

  /** Identity of a message for the repeat cap: same conversation, sender, target and trimmed text. */
  private keyOf(
    conversationId: ConversationId,
    sender: Author,
    target: BotId,
    text: string,
  ): string {
    const who = sender.kind === "bot" ? `bot:${sender.botId}` : sender.kind;
    return `${conversationId}|${who}|${target}|${text.trim()}`;
  }
}
