import type { Database } from "bun:sqlite";
import { appendEvent } from "./thread-event-store";

/* SQL of `peer_messages` (the only place it is written). A send is ONE transaction: the row and the `teammate_message`
   thread event that wakes the target. Posting the echo and the inbound line comes after the commit (the outbox). */

/** A stored peer message. */
export interface PeerMessage {
  id: number;
  deliveryKey: string;
  fromTeammate: string | null;
  toTeammate: string;
  intent: string;
  text: string;
  textHash: string;
  replyTo: number | null;
  hop: number;
  sourceThread: string;
  targetThread: string;
  echoPostedAt: number | null;
  inboundPostedAt: number | null;
  createdAt: number;
}

/** What a send stores (the id and the time are the store's). */
export type NewPeerMessage = Omit<
  PeerMessage,
  "id" | "echoPostedAt" | "inboundPostedAt" | "createdAt"
>;

interface Row {
  id: number;
  delivery_key: string;
  from_teammate: string | null;
  to_teammate: string;
  intent: string;
  text: string;
  text_hash: string;
  reply_to: number | null;
  hop: number;
  source_thread: string;
  target_thread: string;
  echo_posted_at: number | null;
  inbound_posted_at: number | null;
  created_at: number;
}

const toMessage = (r: Row): PeerMessage => ({
  id: r.id,
  deliveryKey: r.delivery_key,
  fromTeammate: r.from_teammate,
  toTeammate: r.to_teammate,
  intent: r.intent,
  text: r.text,
  textHash: r.text_hash,
  replyTo: r.reply_to,
  hop: r.hop,
  sourceThread: r.source_thread,
  targetThread: r.target_thread,
  echoPostedAt: r.echo_posted_at,
  inboundPostedAt: r.inbound_posted_at,
  createdAt: r.created_at,
});

/** The message with this number, or undefined. */
export function peerMessageById(db: Database, id: number): PeerMessage | undefined {
  const r = db.query<Row, [number]>("SELECT * FROM peer_messages WHERE id = ?").get(id);
  return r ? toMessage(r) : undefined;
}

/** The message stored under this delivery key, or undefined. */
export function peerMessageByKey(db: Database, key: string): PeerMessage | undefined {
  const r = db.query<Row, [string]>("SELECT * FROM peer_messages WHERE delivery_key = ?").get(key);
  return r ? toMessage(r) : undefined;
}

/** Messages `from` (null = the default teammate) sent since `sinceMs`. */
export function countPeerSends(db: Database, from: string | null, sinceMs: number): number {
  return (
    db
      .query<{ n: number }, [string | null, string | null, number]>(
        `SELECT COUNT(*) AS n FROM peer_messages WHERE (from_teammate = ? OR (? IS NULL AND from_teammate IS NULL))
         AND created_at >= ?`,
      )
      .get(from, from, sinceMs)?.n ?? 0
  );
}

/** True when `from` sent `to` the same text (by hash) since `sinceMs`. */
export function hasRecentPeerRepeat(
  db: Database,
  m: { from: string | null; to: string; textHash: string },
  sinceMs: number,
): boolean {
  return (
    db
      .query<{ one: number }, [string | null, string | null, string, string, number]>(
        `SELECT 1 AS one FROM peer_messages WHERE (from_teammate = ? OR (? IS NULL AND from_teammate IS NULL))
         AND to_teammate = ? AND text_hash = ? AND created_at >= ? LIMIT 1`,
      )
      .get(m.from, m.from, m.to, m.textHash, sinceMs) != null
  );
}

/** Row of the `teammate_message` event of a message: its id is the message number, so a repeat insert is a no-op. */
export const peerEventId = (id: number): string => `peer:${id}`;

/**
 * Store the message and its wake-up event in ONE transaction; returns the stored message. `sender` is the display name of
 * the sender (the default teammate has none) and goes into the event payload that the target reads as DATA.
 */
export function insertPeerMessage(
  db: Database,
  m: NewPeerMessage,
  sender: string,
  now: number = Date.now(),
): PeerMessage {
  return db.transaction(() => {
    const id = db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO peer_messages (delivery_key, from_teammate, to_teammate, intent, text, text_hash, reply_to, hop,
           source_thread, target_thread, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        m.deliveryKey,
        m.fromTeammate,
        m.toTeammate,
        m.intent,
        m.text,
        m.textHash,
        m.replyTo,
        m.hop,
        m.sourceThread,
        m.targetThread,
        now,
      )?.id as number;
    appendEvent(db, {
      id: peerEventId(id),
      threadId: m.targetThread,
      kind: "teammate_message",
      payload: { from: sender, intent: m.intent, id: `P${id}`, hop: m.hop, text: m.text },
    });
    return peerMessageById(db, id) as PeerMessage;
  })();
}

/** Mark the echo (sender thread) or the inbound line (target thread) as posted. */
export function markPeerPosted(
  db: Database,
  id: number,
  side: "echo" | "inbound",
  now: number = Date.now(),
): void {
  const col = side === "echo" ? "echo_posted_at" : "inbound_posted_at";
  db.query(`UPDATE peer_messages SET ${col} = ? WHERE id = ?`).run(now, id);
}

/** Messages whose echo or inbound line was never posted (a crash between commit and post), oldest first. */
export function unpostedPeerMessages(db: Database): PeerMessage[] {
  return db
    .query<Row, []>(
      "SELECT * FROM peer_messages WHERE echo_posted_at IS NULL OR inbound_posted_at IS NULL ORDER BY id",
    )
    .all()
    .map(toMessage);
}

/** Delete messages older than `beforeMs`; returns how many (retention). */
export function purgePeerMessages(db: Database, beforeMs: number): number {
  return db.query("DELETE FROM peer_messages WHERE created_at < ?").run(beforeMs).changes;
}
