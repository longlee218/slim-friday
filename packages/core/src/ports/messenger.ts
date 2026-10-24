import type { BotId } from "../domain/bot";
import type { WakeIntent } from "../domain/wake";

/** A bot's message to a member of its group. */
export interface SendRequest {
  /** A member's id or exact name (case-insensitive when unique). */
  to: string;
  text: string;
  intent: WakeIntent;
  /** Give the whole step to the member (it answers the owner, not the sender). */
  handoff?: boolean;
}

export type SendResult = { ok: true; wakeId: string; note: string } | { ok: false; error: string };

/** What a bot's tools use to reach another bot; the hub implements it. */
export interface BotMessenger {
  send(from: BotId, req: SendRequest): Promise<SendResult>;
}
