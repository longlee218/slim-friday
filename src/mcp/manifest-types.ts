import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { DiscordAdminContext } from "../discord-setup/discord-admin-context";
import type { MemoryToolContext } from "../memory/memory-tool-context";
import type { LeadToolContext } from "../orchestrator/lead/lead-call";
import type { PlannerCtx } from "../orchestrator/plan/planner-handlers";
import type { ReportSink } from "../orchestrator/worker/report-sink";
import type { EffectsCtx } from "../policy/effect-context";
import type { ReadBudget } from "./memory/memory-read-shared";

/**
 * Everything a run can bring to its MCP tools, as optional parts. A tool reads the part it needs; a run without that
 * part simply does not get the tool (so a worker run, which has no `lead` part, can never hold a lead tool).
 */
export interface RunCtx {
  /** Memory tools; also `SetThreadTitle` (needs `memory.threadTitle`). Absent = no memory (a control-channel run). */
  memory?: MemoryToolContext;
  /** Lead tools: the lead run's port and counters. */
  lead?: LeadToolContext;
  /** Where a worker's `ReportResult` lands. */
  reportSink?: ReportSink;
  /** A worker's `ReportProgress` port, bound to its task (percent + note in, redacted and recorded by the callee). */
  progress?: (p: { percent: number; note: string }) => void;
  /** Planner tools: the planner run bound to its goal. */
  plan?: PlannerCtx;
  /** Effect tools: the worker run's envelope, locations and owner gate. */
  effects?: EffectsCtx;
  /** Discord admin tools: the control-channel run. */
  admin?: DiscordAdminContext;
  /** Per-server-instance read cap shared by the memory read tools (set by the memory manifest's `prepare`). */
  readBudget?: ReadBudget;
}

/** The parts of a `RunCtx` a caller supplies per query() call (everything but memory, which is the run's own). */
export type AppCtx = Omit<RunCtx, "memory" | "readBudget">;

/** Builds the app ctx parts of ONE query() call, so an in-process server instance is never reused across calls. */
export type AppCtxFactory = () => AppCtx;

/** One MCP tool of a server: its bare wire name and the builder (undefined = the run lacks the ctx part it needs). */
export interface McpToolEntry {
  /** Bare tool name (from the tool's own `constants.ts`). */
  name: string;
  /** Builds the tool for one run, or undefined when the run has no ctx for it. */
  // biome-ignore lint/suspicious/noExplicitAny: tool input schemas differ per tool
  create(ctx: RunCtx): SdkMcpToolDefinition<any> | undefined;
}

/** One in-process MCP server: a name and the tools it may hold. Which tools a run really gets is `role.mcpTools`. */
export interface McpServerManifest {
  /** Server name (the `mcp__<name>__` prefix). */
  name: string;
  /** Every tool the server can hold. */
  tools: McpToolEntry[];
  /** Per-instance setup run once when the server is built (shared state, wrapped hooks). */
  prepare?(ctx: RunCtx): RunCtx;
}
