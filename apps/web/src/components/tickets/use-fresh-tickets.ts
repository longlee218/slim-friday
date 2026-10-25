import type { TicketDto } from "@friday/contracts";
import { useEffect, useRef, useState } from "react";

/**
 * Ids of tickets that appeared after the board first finished loading (a bot or the owner
 * created them): their cards play the entry animation. The first full load marks nothing fresh.
 */
export function useFreshTickets(tickets: TicketDto[], loading: boolean): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (loading) return;
    if (!seen.current) {
      seen.current = new Set(tickets.map((t) => t.id));
      return;
    }
    const known = seen.current;
    const added = tickets.filter((t) => !known.has(t.id)).map((t) => t.id);
    if (added.length === 0) return;
    for (const id of added) known.add(id);
    setFresh((f) => new Set([...f, ...added]));
  }, [tickets, loading]);
  return fresh;
}
