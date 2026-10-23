import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../config/agent-config";
import type { ThreadTitlePort } from "../ingress/thread-title";
import type { ApprovalGateway } from "../owner-approval/approval-types";
import type { QueryFn } from "../runtime/run-agent";
import type { RunLimiter } from "./turns/run-limiter";

/* Types shared by handle-message.ts and handler-services.ts (a leaf: neither imports the other for types). */

/** Dependencies of the turn handler. */
export interface TurnHandlerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** Worker pool: concurrent worker runs (a full pool defers the item). */
  limiter?: RunLimiter;
  /** Teammate pool: concurrent teammate runs (a full pool makes the thread wait). Omitted = the teammate system builds the default pool. */
  teammatePool?: RunLimiter;
  /** Owner approval gateway; required for background roles such as developer. */
  approvals?: ApprovalGateway;
  /** Renames threads for `Orchestrate set_title` (offered to every role run); omitted = the tool is not offered. */
  threadTitle?: ThreadTitlePort;
  /** Posts into a thread by id: the teammate's boot wake (a restart) has no owner message to answer through. Omitted = that wake is skipped. */
  post?: (threadId: string, text: string) => Promise<void>;
  /** Open a new thread in a teammate channel (a peer request to a task-mode teammate); returns its id. */
  openThread?: (channelId: string, name: string) => Promise<string>;
  /** Timing knobs of the teammate queue (tests shorten the owner debounce and the announce batch). */
  teammateTiming?: { debounceMs?: number; announceWindowMs?: number };
}
