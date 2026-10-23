import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  CHAIN_CAP,
  PEER_MESSAGE_MAX_CHARS,
  PEER_REPEAT_WINDOW_MS,
  PEER_SENDS_PER_HOUR,
} from "../../config/teammate-caps";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import {
  countPeerSends,
  hasRecentPeerRepeat,
  insertPeerMessage,
  markPeerPosted,
  type PeerMessage,
  peerMessageById,
  peerMessageByKey,
} from "../../storage/peer-message-store";
import { teammateByName } from "../../storage/teammate-store";
import type { Teammate } from "../teammate-types";

const log = logger.child({ module: "peer-message" });

/** What the sender wants from the target. */
export const PEER_INTENTS = ["request", "result", "question", "status", "fyi"] as const;
export type PeerIntent = (typeof PEER_INTENTS)[number];

/** Why a send is refused. */
export type PeerErrorCode =
  | "UNKNOWN_TEAMMATE"
  | "SELF"
  | "TOO_LONG"
  | "BAD_REPLY_TO"
  | "HOP_LIMIT"
  | "REPEAT"
  | "RATE_LIMIT";

/** Result of a send: the message number (`P42`), or a refusal the sender's model reads. */
export type PeerResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; code: PeerErrorCode; message: string };

/** The run that sends: its thread, who it is (null = the default teammate), how deep in a chain it is and its turn. */
export interface PeerSender {
  thread: string;
  teammate: string | null;
  hop: number;
  turnId: string;
}

/** What a send needs from the app (the thread work is Discord's, so it comes in as callbacks). */
export interface PeerSendDeps {
  db: Database;
  now(): number;
  /** Thread that receives a NEW conversation with `target`: its channel (chat mode) or a thread opened for it (task mode). */
  newTargetThread(target: Teammate, sender: string): Promise<string>;
  /** Post text into a thread (a rejection is logged; the outbox sweep posts it later). */
  post(threadId: string, text: string): Promise<void>;
  /** Wake the target thread's teammate. */
  announce(threadId: string): void;
}

const refuse = (code: PeerErrorCode, message: string): PeerResult => ({ ok: false, code, message });

/** Hash of the text as compared by the repeat guard: case and whitespace do not make it new. */
const hashOf = (text: string): string =>
  createHash("sha256")
    .update(text.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);

/** Display name of the sender. */
const displayName = (name: string | null): string => name ?? "default";

/** One-line form of a message for the echo and the inbound post. */
const line = (arrow: string, who: string, intent: string, text: string): string =>
  `${arrow} @${who} (${intent}): ${text.length > 1500 ? `${text.slice(0, 1500)}…` : text}`;

/** The reply target: a message addressed to the sender FROM the target; its sender's thread gets the answer. */
function replyThread(db: Database, replyTo: number, sender: string | null, target: string) {
  const m = peerMessageById(db, replyTo);
  const ok = m && m.toTeammate === displayName(sender) && displayName(m.fromTeammate) === target;
  return ok ? m.sourceThread : undefined;
}

/**
 * Send one peer message. Order: idempotent resend, then the cheap refusals (self, target, size, reply link), then the
 * loop guards (hop, repeat, rate). The row and the target's wake-up event commit together; the echo and the inbound line
 * are posted after (a failed post is left for `flushPeerOutbox`). A `result` answering a real message is exempt from the hop
 * limit (the answer must reach the requester); the hourly cap still bounds it.
 */
export async function sendPeerMessage(
  d: PeerSendDeps,
  from: PeerSender,
  m: { to: string; text: string; intent: PeerIntent; replyTo?: number },
): Promise<PeerResult> {
  const hash = hashOf(m.text);
  const key = `${from.turnId}:${m.to}:${m.intent}:${hash}`;
  const again = peerMessageByKey(d.db, key);
  if (again) return { ok: true, id: `P${again.id}`, duplicate: true };

  if (m.to === from.teammate) return refuse("SELF", "A teammate cannot message itself.");
  const target = teammateByName(d.db, m.to);
  if (!target) return refuse("UNKNOWN_TEAMMATE", `No active teammate called \`${m.to}\`.`);
  if (m.text.length > PEER_MESSAGE_MAX_CHARS)
    return refuse("TOO_LONG", `A peer message is at most ${PEER_MESSAGE_MAX_CHARS} characters.`);
  let thread: string | undefined;
  if (m.replyTo !== undefined) {
    thread = replyThread(d.db, m.replyTo, from.teammate, m.to);
    if (!thread)
      return refuse("BAD_REPLY_TO", `P${m.replyTo} is not a message from \`${m.to}\` to you.`);
  }
  const hop = from.hop + 1;
  if (hop > CHAIN_CAP && !(m.intent === "result" && thread))
    return refuse("HOP_LIMIT", `This chain of peer messages is already ${CHAIN_CAP} deep.`);
  const now = d.now();
  if (
    hasRecentPeerRepeat(
      d.db,
      { from: from.teammate, to: m.to, textHash: hash },
      now - PEER_REPEAT_WINDOW_MS,
    )
  )
    return refuse("REPEAT", "You already sent this message to that teammate a moment ago.");
  if (countPeerSends(d.db, from.teammate, now - 3_600_000) >= PEER_SENDS_PER_HOUR)
    return refuse("RATE_LIMIT", `At most ${PEER_SENDS_PER_HOUR} peer messages per hour.`);

  // A thread failure is a tool error: nothing is written yet.
  const targetThread = thread ?? (await d.newTargetThread(target, displayName(from.teammate)));
  const sent = insertPeerMessage(
    d.db,
    {
      deliveryKey: key,
      fromTeammate: from.teammate,
      toTeammate: m.to,
      intent: m.intent,
      text: m.text,
      textHash: hash,
      replyTo: m.replyTo ?? null,
      hop,
      sourceThread: from.thread,
      targetThread,
    },
    displayName(from.teammate),
    now,
  );
  logEvent(log, "peer.sent", { id: sent.id, from: from.teammate, to: m.to, intent: m.intent, hop });
  await postBoth(d, sent);
  d.announce(targetThread);
  return { ok: true, id: `P${sent.id}`, duplicate: false };
}

/** Post the echo (sender thread) and the inbound line (target thread) that are still missing; each is marked when posted. */
async function postBoth(d: PeerSendDeps, m: PeerMessage): Promise<void> {
  const sides: ["echo" | "inbound", string, string][] = [
    ["echo", m.sourceThread, line("→", m.toTeammate, m.intent, m.text)],
    ["inbound", m.targetThread, line("←", displayName(m.fromTeammate), m.intent, m.text)],
  ];
  for (const [side, thread, text] of sides) {
    if ((side === "echo" ? m.echoPostedAt : m.inboundPostedAt) !== null) continue;
    try {
      await d.post(thread, text);
      markPeerPosted(d.db, m.id, side, d.now());
    } catch (err) {
      log.warn({ id: m.id, side, err: errText(err) }, "peer post failed");
    }
  }
}

/** Boot sweep: post what a crash left unposted. */
export async function flushPeerOutbox(d: PeerSendDeps, unposted: PeerMessage[]): Promise<void> {
  for (const m of unposted) await postBoth(d, m);
}
