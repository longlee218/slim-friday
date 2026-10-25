import type { Store, Surface, Ticket } from "@friday/core";
import type { WorkerToMain } from "./ipc-protocol";

/**
 * Main side: publish what a worker reported on main's surface (the web's event bus). A stored message is read
 * by id and posted; a card is shown when its row is open and closed otherwise (under the bot's current name);
 * activity and run steps go on as they are; a saved ticket is read by id and given to `onTicketChange`; a
 * changed schedule id goes to `onScheduleChange`. A row that is gone is skipped. `ready` and hints are the caller's.
 */
export async function relayWorkerEvents(
  m: WorkerToMain,
  surface: Surface,
  store: Pick<Store, "messages" | "cards" | "bots" | "tickets">,
  /** Main's listener of saved tickets (the web's ticket events); unset: ticket messages are ignored. */
  onTicketChange?: (t: Ticket) => void,
  /** Main's "a schedule changed" hook (ticker kick, web event); unset: schedule messages are ignored. */
  onScheduleChange?: (scheduleId: string) => void,
): Promise<void> {
  switch (m.t) {
    case "post": {
      const msg = await store.messages.get(m.messageId);
      if (msg && msg.conversationId === m.conversationId) await surface.post(m.conversationId, msg);
      return;
    }
    case "card": {
      const card = await store.cards.get(m.cardId);
      if (!card) return;
      if (card.status !== "open") return surface.closeCard(card);
      const name = (await store.bots.get(card.botId))?.name ?? card.botId;
      return surface.showCard(card, name);
    }
    case "activity":
      return surface.showActivity(m.conversationId, m.activity);
    case "run_step":
      return surface.showRun(m.conversationId, m.botId, m.step);
    case "finished":
      return surface.notifyFinished({
        conversationId: m.conversationId,
        botId: m.botId,
        preview: m.preview,
      });
    case "ticket": {
      const ticket = onTicketChange && (await store.tickets.get(m.ticketId));
      if (ticket) onTicketChange?.(ticket);
      return;
    }
    case "schedule":
      onScheduleChange?.(m.scheduleId);
      return;
    default:
      return;
  }
}
