import type { Store } from "../ports/store";
import { parseTicketRef, type Ticket, ticketRef } from "./ticket";
import { finished, type TicketResult } from "./ticket-board-rules";

/** Most tickets one ticket may wait on. */
export const BLOCKERS_MAX = 10;

type TicketStore = Pick<Store, "tickets">;

const invalid = (error: string) => ({ ok: false, code: "invalid", error }) as const;

/** A ticket by ref (`FRI-3`, any case) or by id. */
async function lookup(store: TicketStore, refOrId: string): Promise<Ticket | undefined> {
  const n = parseTicketRef(refOrId);
  return n !== undefined ? store.tickets.getByNumber(n) : store.tickets.get(refOrId.trim());
}

/** Does `from` wait on `targetId`, directly or through its own blockers? */
async function waitsOn(store: TicketStore, from: Ticket, targetId: string): Promise<boolean> {
  const seen = new Set<string>();
  const queue = [...(from.blockedBy ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...((await store.tickets.get(id))?.blockedBy ?? []));
  }
  return false;
}

/**
 * Resolve the refs (or ids) a ticket should wait on to ticket ids. Refused, naming the ref: an
 * unknown ticket, the ticket itself (`selfId`), a blocker that already waits on it, more than 10.
 */
export async function resolveBlockers(
  store: TicketStore,
  selfId: string | undefined,
  refs: string[],
): Promise<TicketResult<{ ids: string[] }>> {
  const ids: string[] = [];
  for (const r of refs) {
    const t = await lookup(store, r);
    if (!t) return invalid(`Unknown ticket ${r.trim()}.`);
    if (t.id === selfId) return invalid("A ticket cannot wait on itself.");
    if (selfId && (await waitsOn(store, t, selfId)))
      return invalid(`${ticketRef(t.number)} already waits on this ticket.`);
    if (!ids.includes(t.id)) ids.push(t.id);
    // Stop at the first one too many: a long list is never walked in full.
    if (ids.length > BLOCKERS_MAX) return invalid(`At most ${BLOCKERS_MAX} blockers.`);
  }
  return { ok: true, ids };
}

/** Every ticket `t` waits on, in its `blockedBy` order (a missing one is skipped). */
export async function blockersOf(store: TicketStore, t: Ticket): Promise<Ticket[]> {
  const all = await Promise.all((t.blockedBy ?? []).map((id) => store.tickets.get(id)));
  return all.filter((b): b is Ticket => b !== undefined);
}

/** The blockers of `t` that are not `done` or `closed` yet. */
export async function waitingOn(store: TicketStore, t: Ticket): Promise<Ticket[]> {
  return (await blockersOf(store, t)).filter((b) => !finished(b.status));
}

/** Is `t` waiting: does any of its blockers still have to finish? */
export async function isWaiting(store: TicketStore, t: Ticket): Promise<boolean> {
  return (await waitingOn(store, t)).length > 0;
}

/** May `t` be worked on: not finished and waiting on nothing? A waiting ticket is woken on release. */
export async function readyToWork(store: TicketStore, t: Ticket): Promise<boolean> {
  return !finished(t.status) && !(await isWaiting(store, t));
}

/** Refusal: a started ticket (not `todo`) cannot be put back to waiting. */
export const STARTED_CANNOT_WAIT = invalid("A started ticket cannot wait on other tickets.");
