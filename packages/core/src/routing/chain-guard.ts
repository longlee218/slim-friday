import { CORE_DEFAULTS, type CoreLimits } from "../config-defaults";
import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";
import type { Clock } from "../ports/clock";

/** One bot being woken by one message. */
export interface Wake {
  conversationId: ConversationId;
  sender: Author;
  target: BotId;
  text: string;
  /** Hand-offs since the user message that started the chain. */
  hop: number;
}

export type GuardResult = { ok: true } | { ok: false; reason: "hops" | "rate" | "repeat" };

const HOUR_MS = 3_600_000;

/** Stops runaway bot-to-bot chains: too many hops, too many bot messages, or a bot repeating itself. */
export class ChainGuard {
  /** Time of each recorded wake, with what is needed to judge a repeat or the hourly rate. */
  private log: { at: number; conversationId: ConversationId; key: string; fromBot: boolean }[] = [];

  constructor(
    private clock: Clock,
    private limits: CoreLimits = CORE_DEFAULTS,
  ) {}

  /** Would this wake be allowed? Does not record it. */
  check(w: Wake): GuardResult {
    if (w.hop > this.limits.maxHops) return { ok: false, reason: "hops" };
    const now = this.clock.now();
    this.log = this.log.filter((e) => now - e.at < Math.max(HOUR_MS, this.limits.repeatWindowMs));
    if (w.sender.kind === "bot") {
      const lastHour = this.log.filter(
        (e) => e.fromBot && e.conversationId === w.conversationId && now - e.at < HOUR_MS,
      ).length;
      if (lastHour >= this.limits.maxBotMessagesPerConversationPerHour)
        return { ok: false, reason: "rate" };
    }
    if (w.sender.kind !== "bot") return { ok: true }; // a user may repeat a message
    const key = this.keyOf(w);
    if (this.log.some((e) => e.key === key && now - e.at < this.limits.repeatWindowMs))
      return { ok: false, reason: "repeat" };
    return { ok: true };
  }

  /** Rebuild the log from stored wakes (after a restart), so the caps still count what was sent before. */
  seed(
    rows: {
      createdAt: number;
      conversationId: ConversationId;
      sender: Author;
      targetBot: BotId;
      text: string;
    }[],
  ): void {
    for (const r of rows)
      this.log.push({
        at: r.createdAt,
        conversationId: r.conversationId,
        key: this.keyOf({
          conversationId: r.conversationId,
          sender: r.sender,
          target: r.targetBot,
          text: r.text,
          hop: 0,
        }),
        fromBot: r.sender.kind === "bot",
      });
  }

  /** Remember a delivered wake. */
  record(w: Wake): void {
    this.log.push({
      at: this.clock.now(),
      conversationId: w.conversationId,
      key: this.keyOf(w),
      fromBot: w.sender.kind === "bot",
    });
  }

  private keyOf(w: Wake): string {
    const who = w.sender.kind === "bot" ? `bot:${w.sender.botId}` : w.sender.kind;
    return `${w.conversationId}|${who}|${w.target}|${w.text.trim()}`;
  }
}
