import type { Conversation, InsightStore, McpOAuthStore, Store } from "@friday/core";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openEngineDb } from "./open-engine-db";
import { attemptRepo } from "./repos/attempt-repo";
import { auditRepo } from "./repos/audit-repo";
import { cardRepo } from "./repos/card-repo";
import { conversationRepo } from "./repos/conversation-repo";
import { effectCallRepo } from "./repos/effect-call-repo";
import { fileRepo } from "./repos/file-repo";
import { grantRepo } from "./repos/grant-repo";
import { insightRepo } from "./repos/insight-repo";
import { mcpOAuthRepo } from "./repos/mcp-oauth-repo";
import { messageRepo } from "./repos/message-repo";
import { readRepo } from "./repos/read-repo";
import { scopeRepo } from "./repos/scope-repo";
import { scheduleRepo } from "./repos/schedule-repo";
import { scheduleRunRepo } from "./repos/schedule-run-repo";
import { scratchpadRepo } from "./repos/scratchpad-repo";
import { sessionRepo } from "./repos/session-repo";
import { spendRepo } from "./repos/spend-repo";
import { steeringRepo } from "./repos/steering-repo";
import { ticketEventRepo } from "./repos/ticket-event-repo";
import { ticketRepo } from "./repos/ticket-repo";
import { uploadRepo } from "./repos/upload-repo";
import { wakeRepo } from "./repos/wake-repo";

/** The parts of the core `Store` kept in the db (bots and groups live in files, see `@friday/config`). */
export type EngineStore = Omit<Store, "bots" | "groups" | "conversations"> & {
  conversations: Store["conversations"] & { put(c: Conversation): Promise<void> };
  /** Read-only views for reviewing bots (`BotInsight`). */
  insight: InsightStore;
  /** OAuth logins of MCP servers (not part of the core `Store`). */
  mcpOAuth: McpOAuthStore;
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
    files: fileRepo(db),
    uploads: uploadRepo(db),
    reads: readRepo(db),
    grants: grantRepo(db),
    sessions: sessionRepo(db),
    spend: spendRepo(db),
    audit: auditRepo(db),
    wakes: wakeRepo(db),
    attempts: attemptRepo(db),
    steering: steeringRepo(db),
    cards: cardRepo(db),
    effects: effectCallRepo(db),
    scopes: scopeRepo(db),
    scratchpad: scratchpadRepo(db),
    schedules: scheduleRepo(db),
    scheduleRuns: scheduleRunRepo(db),
    tickets: ticketRepo(db),
    ticketEvents: ticketEventRepo(db),
    insight: insightRepo(db),
    mcpOAuth: mcpOAuthRepo(db),
    close: () => client.close(),
  };
}
