import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../../approvals/approval-types";
import type { AgentConfig } from "../../config/agent-config";
import type { Route } from "../../config/model-routing";
import type { Repo } from "../../repos/repo-registry";
import type { QueryFn } from "../../runtime/run-agent";
import type { SessionRow } from "../../storage/session-store";
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
}

/** One role run: a fresh message, a dispatched task, or the continuation of one (`resume`). */
export interface RoleRunInput {
  /** Called once the run's start checks passed (role valid, repo reachable): the caller drops what this run continues. */
  onStarted?: () => void;
  turnId: string;
  threadId: string;
  text: string;
  /** Role to run (registry name). */
  role: string;
  /** Workspace the run belongs to; every repo lookup of the flow stays inside it. */
  workspace: string;
  /** Repos the run may use (the role's `repoScope` decided which). */
  repos: Repo[];
  /** The task's abort controller (`stop`, shutdown). */
  ac: AbortController;
  /** Class, effort and `go +<usd>` raise of this run (model + budget routing). */
  route?: Route;
  /** The repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** Foreground roles: stored session of the thread, resumed when its cwd still matches. */
  existing?: SessionRow | null;
  /** Task ledger of the thread (idle thread only); empty = none. */
  ledger?: string;
  /** Continue this saved session in its cwd (interrupt Resume, `/go`): the task's own, never the thread's. */
  resume?: { sessionId: string; cwd: string };
}
