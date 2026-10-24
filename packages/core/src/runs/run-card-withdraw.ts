import type { CardRow } from "../domain/card";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { closeOnSurface } from "./run-card-answer";

/**
 * Withdraw these open cards (guarded open -> withdrawn, so a card answered meanwhile stays answered) and
 * close each withdrawn one on the surface. Returns how many were withdrawn.
 */
export async function withdrawCards(ctx: HubContext, cards: CardRow[]): Promise<number> {
  let n = 0;
  for (const card of cards) {
    if (!(await ctx.deps.store.cards.setStatus(card.id, "open", "withdrawn"))) continue;
    closeOnSurface(ctx, { ...card, status: "withdrawn" });
    n++;
  }
  return n;
}

/**
 * Reconciler repair: open cards whose run was cancelled (Stop wrote the cancel but the process died before it
 * withdrew them) are withdrawn, so nothing stays open for a run that will never resume.
 */
export async function withdrawCardsOfCancelled(ctx: HubContext): Promise<void> {
  const { store } = ctx.deps;
  const dead: CardRow[] = [];
  for (const card of await store.cards.open()) {
    try {
      if ((await store.wakes.get(card.wakeId))?.status === "cancelled") dead.push(card);
    } catch (err) {
      ctx.deps.log?.error({ error: errText(err), cardId: card.id }, "hub.reconcile_row_failed");
    }
  }
  await withdrawCards(ctx, dead);
}
