import type { Conversation, Store } from "@friday/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openEngineDb } from "./open-engine-db";
import { auditRepo } from "./repos/audit-repo";
import { conversationRepo } from "./repos/conversation-repo";
import { grantRepo } from "./repos/grant-repo";
import { messageRepo } from "./repos/message-repo";
import { sessionRepo } from "./repos/session-repo";
import { spendRepo } from "./repos/spend-repo";
import { ticketRepo } from "./repos/ticket-repo";
import { wakeRepo } from "./repos/wake-repo";

/** The parts of the core `Store` kept in the db (bots and groups live in files, see `@friday/config`). */
export type EngineStore = Omit<Store, "bots" | "groups" | "conversations"> & {
  conversations: Store["conversations"] & { put(c: Conversation): Promise<void> };
  /** Close the db. */
  close(): void;
};

/** Open the engine db at `file` and serve the db-backed repositories. */
export function openEngineStore(file: string): EngineStore {
  const client = openEngineDb(file);
  const db = drizzle({ client });
  return {
    conversations: conversationRepo(db),
    messages: messageRepo(db),
    grants: grantRepo(db),
    sessions: sessionRepo(db),
    spend: spendRepo(db),
    audit: auditRepo(db),
    wakes: wakeRepo(db),
    tickets: ticketRepo(db),
    close: () => client.close(),
  };
}
