import type { Bot, BotId } from "@friday/core";

/** The lowest cdp port of a bot's Chromium inside its computer. */
export const CDP_BASE_PORT = 9300;
/** Ports 9300..9999. */
export const CDP_PORT_RANGE = 700;

/** 32-bit FNV-1a hash of a string's UTF-16 code units (ids are ASCII). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The cdp port of a bot's Chromium: 9300 + fnv1a32(id) % 700, stable whatever other bots exist, so a running
 * Chromium keeps its port. When two bots on one computer hash to one port, the later id (sorted) takes the next free
 * port (wrapping to 9300) and `onShift(moved, holder)` is told.
 */
export function cdpPortOf(
  botId: BotId,
  computer: string,
  bots: Bot[],
  onShift?: (moved: BotId, holder: BotId) => void,
): number {
  const ids = bots
    .filter((b) => b.computer === computer && b.id !== botId)
    .map((b) => b.id)
    .concat(botId)
    .sort();
  const taken = new Map<number, BotId>();
  for (const id of ids) {
    const want = CDP_BASE_PORT + (fnv1a32(id) % CDP_PORT_RANGE);
    let port = want;
    while (taken.has(port)) port = CDP_BASE_PORT + ((port - CDP_BASE_PORT + 1) % CDP_PORT_RANGE);
    if (port !== want) onShift?.(id, taken.get(want) as BotId);
    taken.set(port, id);
    if (id === botId) return port;
  }
  return CDP_BASE_PORT + (fnv1a32(botId) % CDP_PORT_RANGE);
}
