import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../../approvals/approval-types";
import type { AgentConfig } from "../../config/agent-config";
import type { Route } from "../../config/model-routing";
import type { ThreadTitlePort } from "../../ingress/thread-rename";
import type { OwnerLanguage } from "../../ingress/user-copy";
import type { RecentMessage } from "../../intent/intent-types";
import type { Location } from "../../locations/location-registry";
import type { AppServersFactory } from "../../mcp/mcp-servers";
import type { QueryFn } from "../../runtime/run-agent";
import type { AskQuestion } from "../../runtime/tool-permissions";
import type { SessionRow } from "../../storage/session-store";
import type { DispatchEnvelope } from "../approval/envelope";
import type { RunLimiter } from "../turns/run-limiter";
import type { SteerRegistry } from "../turns/steer-registry";

/* Input and dependency types of the role runner (run-role.ts). */

/** Dependencies of the role runner. */
export interface RoleRunnerDeps {
  db: Database;
  config: AgentConfig;
  approvals: ApprovalGateway;
  queryFn?: QueryFn;
  /** True once shutdown aborted the runs: an aborted run is then `interrupted`, not `cancelled`. */
  stopping?: () => boolean;
  /** Where streaming runs register their input so the owner can steer them. Omitted = string prompts, no steer. */
  steer?: SteerRegistry;
  /** Renames the thread for `SetThreadTitle` (every role; rollover/lean runs never get it). Omitted = the tool is not offered. */
  threadTitle?: ThreadTitlePort;
}

/** Dependencies of a task run: the role runner's, plus whether shutdown is aborting runs and the global run cap. */
export interface DispatchDeps extends RoleRunnerDeps {
  /** True once shutdown aborted the runs: an aborted task is then `interrupted` (resumable), not cancelled. */
  stopping: () => boolean;
  /** Global run cap: a detached task run takes its own slot from it. */
  limiter?: RunLimiter;
}

/** One role run: a fresh message, a dispatched task, or the continuation of one (`resume`). */
export interface RoleRunInput {
  /** Called once the run's start checks passed (role valid, location reachable): the caller drops what this run continues. */
  onStarted?: () => void;
  /** Owner's conversation language (pinned by ingress); absent = the thread's pinned language. */
  language?: OwnerLanguage;
  /** Marks the first visible response posted (a question to the owner is one). */
  onVisible?: () => void | Promise<void>;
  turnId: string;
  threadId: string;
  text: string;
  /** Role to run (registry name). */
  role: string;
  /** Workspace the run belongs to; every location lookup of the flow stays inside it. Absent = a control-channel run (no workspace, no location, no memory). */
  workspace?: string;
  /** Builds the in-process app MCP servers (by name, see `RoleDefinition.mcpServers`) on every query() call; only the ones the role lists are used. */
  appServers?: AppServersFactory;
  /** Channel (yaml name) the run started in: persona, memory and `Remember` scope `channel`. */
  channel?: string;
  /** Mode of that channel (`chat` skips the channel digest); absent = `task`. */
  channelMode?: "task" | "chat";
  /** Discord channel id the run started in (the thread's parent): stamped on thread rows `SetThreadTitle` creates. */
  channelId?: string;
  /** Locations the run may use. */
  locations: Location[];
  /** The task's abort controller (`stop`, shutdown). */
  ac: AbortController;
  /** Internal hint, extra budget and spent-so-far of this run (budget routing). */
  route?: Route;
  /** The location the thread is pinned to, when any. */
  pinned?: Location;
  /** Foreground roles: stored session of the thread, resumed when its cwd still matches. */
  existing?: SessionRow | null;
  /** The thread's last messages before this one (Discord history): seed of a fresh session after a rollover. */
  recent?: RecentMessage[];
  /** Task ledger of the thread (idle thread only); empty = none. */
  ledger?: string;
  /** Extra system-context blocks of this run (the lead's LEAD.md); appended after the persona / memory context. */
  extraSystem?: string[];
  /** Dispatched worker run: no SDK subagent tools even when the role allows them (depth 1, developer included). */
  noSubagents?: boolean;
  /** Envelope of a dispatched worker: its shell is an allowlist and every tool call is checked against it. Omitted = no envelope. */
  envelope?: DispatchEnvelope;
  /** Where the typed question of a worker's AskUserQuestion goes instead of the owner (the run's `code` hook); omitted = the owner's buttons. */
  askRelay?: (questions: AskQuestion[]) => Promise<Record<string, string> | undefined>;
  /** Continue this saved session in its cwd (an interrupted task): the task's own, never the thread's. */
  resume?: { sessionId: string; cwd: string };
}
