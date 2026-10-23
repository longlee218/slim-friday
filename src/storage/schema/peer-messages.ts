import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A message one teammate sent to another (`MessageTeammate`). The delivery itself is a `teammate_message` thread event. */
export const peer_messages = sqliteTable(
  "peer_messages",
  {
    /** Message number: shown as `P<id>`. */
    id: integer().primaryKey({ autoIncrement: true }),
    /** `${turnId}:${target}:${hash}`: a resumed run that sends the same message again finds this row. */
    delivery_key: text().notNull().unique(),
    /** Sending teammate name; null = the default (unnamed) teammate of a channel. */
    from_teammate: text(),
    /** Target teammate name. */
    to_teammate: text().notNull(),
    /** request | result | question | status | fyi. */
    intent: text().notNull(),
    text: text().notNull(),
    /** Hash of the normalized text (the repeat guard). */
    text_hash: text().notNull(),
    /** Message this one answers (its sender's thread receives it). */
    reply_to: integer(),
    /** Chain depth of this message (the sender's run depth + 1). */
    hop: integer().notNull(),
    /** Thread of the sender (the echo goes here). */
    source_thread: text().notNull(),
    /** Thread of the target (the inbound line and the wake-up go here). */
    target_thread: text().notNull(),
    /** Epoch ms the echo / the inbound line was posted; null = not yet (the boot sweep posts it). */
    echo_posted_at: integer(),
    inbound_posted_at: integer(),
    created_at: integer().notNull(),
  },
  (t) => [
    index("peer_messages_from_idx").on(t.from_teammate, t.created_at),
    index("peer_messages_target_idx").on(t.target_thread, t.created_at),
  ],
);
