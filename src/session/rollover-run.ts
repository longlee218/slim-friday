import type { Database } from "bun:sqlite";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import type { RecentMessage } from "../ingress/intent-types";
import { buildMemoryToolContext } from "../memory/memory-context";
import type { MemoryToolContext } from "../memory/memory-tool-context";
import { getRole } from "../roles/role-registry";
import type { RoleDefinition } from "../roles/role-types";
import { type LeanRun, type QueryFn, type RunAgentResult, runAgent } from "../runtime/run-agent";
import type { SessionRow } from "../storage/session-store";

/* Shared plumbing of the rollover's model runs (flush, `/compact`): a resumed, lean run of the thread's session. */

/** What a rollover needs from the app (the handler owns them). */
export interface RolloverDeps {
  db: Database;
  config: AgentConfig;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
  /** The thread's last `limit` messages, oldest first (Discord history); omitted / failing = none. */
  history?: (limit: number) => Promise<RecentMessage[]>;
  /** Aborts the rollover (shutdown, `/stop`, the total time cap): every run of it stops, the steps after it do not start. */
  signal?: AbortSignal;
}

/* Budget of one lean step. The resumed session re-reads its whole context (possibly as a cache WRITE if the cache
   expired), so a fixed cap could trip before the flush saves or the summary is written. The budget scales with the
   context that triggered the rollover. The prices are ESTIMATES (USD per million input tokens, cache write), by model
   tier; update them when pricing changes. */
const PRICE_PER_MTOK_USD = { haiku: 1.25, sonnet: 3.75, opus: 18.75 } as const;
/** Tier when the model is unknown or none of the above: the middle one. */
const PRICE_DEFAULT_TIER = "sonnet";
/** Budget = context cost x this factor (reads the context once, plus a few calls and the output). */
const BUDGET_FACTOR = 2;
/** Hard upper cap of one rollover step (USD): a runaway context cannot spend more. */
export const BUDGET_CAP_USD = 3;

/** Budget (USD) of a lean step: `max(floor, context x price x factor)`, never above `BUDGET_CAP_USD`. */
export function leanBudgetUsd(floorUsd: number, contextTokens: number, model?: string): number {
  const tier = (["haiku", "sonnet", "opus"] as const).find((t) => model?.toLowerCase().includes(t));
  const price = PRICE_PER_MTOK_USD[tier ?? PRICE_DEFAULT_TIER];
  return Math.min(
    BUDGET_CAP_USD,
    Math.max(floorUsd, (contextTokens * price * BUDGET_FACTOR) / 1e6),
  );
}

/** One rollover to run: the thread, its workspace, the role of the run that crossed the threshold, and the gauges. */
export interface RolloverRequest {
  /** The turn that crossed the threshold (the lean runs are recorded under it). */
  turnId: string;
  threadId: string;
  workspace: string;
  role: string;
  contextTokens: number;
  window: number;
  /** Main model of the run that crossed the threshold (price tier of the lean budgets); unknown = middle tier. */
  model?: string;
}

/** The role of a lean run: the same role (model slot, persona), with nothing it could use besides the given memory tools. */
function leanRole(name: string, memoryTools: string[]): RoleDefinition {
  return {
    ...getRole(name),
    capabilities: [],
    skills: [],
    mcpTools: memoryTools,
    permissionMode: undefined,
    streaming: false,
  };
}

/**
 * Run `prompt` once, resumed on the thread's session (same cwd), as a lean run with its own deadline.
 * `memory` adds to the thread's memory context (e.g. no `threadId` = no compaction hooks). Never throws for a model
 * failure (the result carries the outcome); a timeout aborts the run.
 */
export async function runLean(
  d: RolloverDeps,
  req: RolloverRequest,
  session: SessionRow,
  o: {
    prompt: string;
    lean: Omit<LeanRun, "budgetUsd"> & {
      budgetFloorUsd: number;
      /** Bare memory tool names the lean run may call (becomes the lean role's `mcpTools`). */
      memoryTools: string[];
    };
    timeoutMs: number;
    memory: (base: MemoryToolContext) => MemoryToolContext;
    onMessage?: (msg: SDKMessage) => void;
  },
): Promise<RunAgentResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  const onAbort = () => ac.abort();
  if (d.signal?.aborted) ac.abort();
  else d.signal?.addEventListener("abort", onAbort, { once: true });
  const { budgetFloorUsd, memoryTools, ...lean } = o.lean;
  try {
    const base = buildMemoryToolContext({
      db: d.db,
      home: d.config.agentHome,
      workspace: req.workspace,
      location: session.location === "*" ? undefined : session.location,
      threadId: req.threadId,
      trackSummary: true,
    });
    return await runAgent({
      role: leanRole(req.role, memoryTools),
      prompt: o.prompt,
      turnId: req.turnId, // its runs rows join the turn that crossed the threshold
      cwd: session.cwd,
      resume: session.session_id,
      memory: o.memory(base),
      lean: { ...lean, budgetUsd: leanBudgetUsd(budgetFloorUsd, req.contextTokens, req.model) },
      onMessage: o.onMessage,
      config: d.config,
      db: d.db,
      abortController: ac,
      queryFn: d.queryFn,
    });
  } finally {
    clearTimeout(timer);
    d.signal?.removeEventListener("abort", onAbort);
  }
}
