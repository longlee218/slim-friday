import type { Store, Surface } from "@friday/core";

/**
 * Show every stored open card on the surface (at start: cards outlive the process, so the owner can still
 * answer what a run asked before a restart). The bot's current name is used; a removed bot shows its id.
 */
export async function showOpenCards(store: Pick<Store, "cards" | "bots">, surface: Surface) {
  for (const card of await store.cards.open()) {
    const name = (await store.bots.get(card.botId))?.name ?? card.botId;
    surface.showCard(card, name);
  }
}
