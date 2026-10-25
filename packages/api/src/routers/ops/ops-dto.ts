import type { WakeDto } from "@friday/contracts";
import type { WakeRow } from "@friday/core";

/** A wake as the web app sees it: metadata only, never the text or attachments. */
export function toWakeDto(w: WakeRow): WakeDto {
  return {
    id: w.id,
    chainId: w.chainId,
    conversationId: w.conversationId,
    targetBot: w.targetBot,
    sender: w.sender,
    intent: w.intent,
    hop: w.hop,
    status: w.status,
    ...(w.blockReason && { blockReason: w.blockReason }),
    attempts: w.attempts,
    ...(w.ticketId && { ticketId: w.ticketId }),
    ...(w.handoff && { handoff: w.handoff }),
    createdAt: w.createdAt,
    ...(w.startedAt !== undefined && { startedAt: w.startedAt }),
    ...(w.firstTextAt !== undefined && { firstTextAt: w.firstTextAt }),
    ...(w.endedAt !== undefined && { endedAt: w.endedAt }),
  };
}
