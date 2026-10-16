import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../config/agent-config";
import type { ThreadTitlePort } from "../ingress/thread-rename";
import type { ApprovalGateway } from "../owner-approval/approval-types";
import type { QueryFn } from "../runtime/run-agent";
import type { RunLimiter } from "./turns/run-limiter";

/* Types shared by handle-message.ts and handler-services.ts (a leaf: neither imports the other for types). */

/** What the handler needs of the control-channel runner (built by index.ts and injected): the shutdown hooks. */
export interface ControlHandle {
  /** Shutdown: abort every control run in flight. */
  abortAll(): void;
  /** Shutdown: abort, wait for the runs to end (at most `ms`) and return the time left. */
  drain(ms: number): Promise<number>;
}

/** Dependencies of the turn handler. */
export interface TurnHandlerDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** Optional global concurrency cap shared by the lead runs and the worker runs. */
  limiter?: RunLimiter;
  /** Owner approval gateway; required for background roles such as developer. */
  approvals?: ApprovalGateway;
  /** Renames threads for `SetThreadTitle` (offered to every role run; not rollover runs); omitted = the tool is not offered. */
  threadTitle?: ThreadTitlePort;
  /** Posts into a thread by id: the lead's boot wake (a restart) has no owner message to answer through. Omitted = that wake is skipped. */
  post?: (threadId: string, text: string) => Promise<void>;
  /** The control-channel runner (see `ControlHandle`); index.ts also gives the same runner to the Discord bot. Omitted = none. */
  control?: ControlHandle;
  /** Timing knobs of the lead queue (tests shorten the owner debounce and the announce batch). */
  leadTiming?: { debounceMs?: number; announceWindowMs?: number };
}
