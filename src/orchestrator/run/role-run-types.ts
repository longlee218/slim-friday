import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import type { Route } from "../../config/model-routing";
import type { ThreadTitlePort } from "../../ingress/thread-title";
import type { OwnerLanguage } from "../../ingress/user-copy";
import type { Location } from "../../locations/location-registry";
import type { AppCtxFactory } from "../../mcp/manifest-types";
import type { MemoryJobs } from "../../memory/memory-jobs";
import type { ApprovalGateway } from "../../owner-approval/approval-types";
import type { DispatchEnvelope } from "../../policy/envelope";
import type { QueryFn } from "../../runtime/run-agent";
import type { AskQuestion } from "../../runtime/tool-permissions";
import type { SessionRow } from "../../storage/session-store";
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
  /** Renames the thread for `Orchestrate set_title` (lead only: only the lead lists the tool in its `mcpTools`). Omitted = the tool is not offered. */
  threadTitle?: ThreadTitlePort;
  /** Background memory jobs: a foreground run's compaction schedules its flush here. Omitted = no flush (tests, headless). */
  memoryJobs?: MemoryJobs;
}

/** Dependencies of a task run: the role runner's, plus whether shutdown is aborting runs and the run pools. */
export interface DispatchDeps extends RoleRunnerDeps {
  /** True once shutdown aborted the runs: an aborted task is then `interrupted` (resumable), not cancelled. */
  stopping: () => boolean;
  /** Worker pool: a detached task run takes its own slot from it. */
  limiter?: RunLimiter;
  /** Lead pool: a lead run takes its own slot from it (never a worker slot). */
  leadPool?: RunLimiter;
}

/** One role run: a fresh message, a dispatched task, or the continuation of one (`resume`). */
export interface RoleRunInput {
  /** Called with the cwd the run works in, once its scope is built (a worker records it: a resume must use the same cwd). */
  onCwd?: (cwd: string) => void;
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
  /** Builds the app ctx parts of the MCP tools (lead, report sink, plan, effects, admin) on every query() call; the role's `mcpTools` picks the tools. */
  appCtx?: AppCtxFactory;
  /** Channel (yaml name) the run started in: persona, memory and `MemorySave` scope `channel`. */
  channel?: string;
  /** Mode of that channel (`chat` skips the channel digest); absent = `task`. */
  channelMode?: "task" | "chat";
  /** Discord channel id the run started in (the thread's parent): stamped on thread rows `Orchestrate set_title` creates. */
  channelId?: string;
  /** Turn and budget limits that replace the role's own for this run (the lead's owner-message run). */
  limitsOverride?: { maxTurns: number; budgetUsd: number };
  /** Locations the run may use. */
  locations: Location[];
  /** The task's abort controller (`/stop`, shutdown). */
  ac: AbortController;
  /** Internal hint, extra budget and spent-so-far of this run (budget routing). */
  route?: Route;
  /** The location the thread is pinned to, when any. */
  pinned?: Location;
  /** Foreground roles: stored session of the thread, resumed when its cwd still matches. */
  existing?: SessionRow | null;
  /** Task ledger of the thread (idle thread only); empty = none. */
  ledger?: string;
  /** The lead's TEAM.md (roster, locations, how to delegate): placed after AGENTS.md in its persona block. */
  team?: string;
  /** Envelope of a dispatched worker: its shell runs in the OS sandbox and every tool call is checked against it. Omitted = no envelope. */
  envelope?: DispatchEnvelope;
  /** Where the typed question of a worker's AskUserQuestion goes instead of the owner (the run's `code` hook); omitted = the owner's buttons. */
  askRelay?: (questions: AskQuestion[]) => Promise<Record<string, string> | undefined>;
  /**
   * Continue this saved session (an interrupted task): the task's own, never the thread's. `cwd` absent = a worker's
   * deterministic cwd (its pinned location), which is where its session was keyed.
   */
  resume?: { sessionId: string; cwd?: string };
}
