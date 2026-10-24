import type { Author, Store } from "@friday/core";
import { asc, desc, eq, gt } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { messages } from "../schema/engine-tables";

/** Messages of every conversation. */
export function messageRepo(db: BunSQLiteDatabase): Store["messages"] {
  return {
    async append(m) {
      db.insert(messages)
        .values({
          conversationId: m.conversationId,
          authorKind: m.author.kind,
          authorBotId: m.author.kind === "bot" ? m.author.botId : null,
          text: m.text,
          at: m.at,
        })
        .run();
    },
    async recent(c, limit) {
      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, c))
        .orderBy(desc(messages.id))
        .limit(limit)
        .all();
      // Newest first from the query; the port wants the last N oldest first.
      return rows.reverse().map((r) => ({
        conversationId: r.conversationId,
        author: authorOf(r),
        text: r.text,
        at: r.at,
      }));
    },
    async after(afterId, limit) {
      return db
        .select()
        .from(messages)
        .where(gt(messages.id, afterId))
        .orderBy(asc(messages.id))
        .limit(limit)
        .all()
        .map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          author: authorOf(r),
          text: r.text,
          at: r.at,
        }));
    },
  };
}

/** The author of a stored row. */
function authorOf(r: { authorKind: string; authorBotId: string | null }): Author {
  if (r.authorKind === "bot") return { kind: "bot", botId: r.authorBotId ?? "" };
  return r.authorKind === "system" ? { kind: "system" } : { kind: "user" };
}
