import type {
  McpHttpServerConfig,
  McpStdioServerConfig,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { ArtifactToolCtx } from "../artifacts/artifact-access";
import type { MemoryToolContext } from "../memory/memory-tool-context";
import type { TeammateToolContext } from "../orchestrator/teammate/teammate-call";
import type { ReportFilesCtx } from "../orchestrator/worker/report-files";
import type { ReportSink } from "../orchestrator/worker/report-sink";
import type { EffectsCtx } from "../policy/effect-context";
import type { ReadBudget } from "./memory/memory-read-shared";
import type { TaskBoardCtx } from "./orchestration/tools/TaskBoardTool/task-board-ctx";

/**
 * Everything a run can bring to its MCP tools, as optional parts. A tool reads the part it needs; a run without that
 * part simply does not get the tool (so a worker run, which has no `teammate` part, can never hold a teammate tool).
 */
export interface RunCtx {
  /** Memory tools; also `Orchestrate set_title` (needs `memory.threadTitle`). Absent = no memory (a control-channel run). */
  memory?: MemoryToolContext;
  /** Teammate tools: the teammate run's port and counters. */
  teammate?: TeammateToolContext;
  /** The run's own scratch dir (a dispatched worker): where its screenshots are checked from. */
  scratchDir?: string;
  /** Where a worker's `Report result` `files` are checked and scratch ones copied. */
  reportFiles?: Omit<ReportFilesCtx, "scratchDir">;
  /** Where a worker's `Report` result lands. */
  reportSink?: ReportSink;
  /** A worker's `Report` progress port, bound to its task (percent + note in, redacted and recorded by the callee). */
  progress?: (p: { percent: number; note: string }) => void;
  /** A worker's `Report` message port, bound to its task: stores a message of the task's thread, returns its ref (`M42`). */
  message?: (kind: "blocker", text: string) => string;
  /** `TaskBoard` (teammate and workers): the app db and the run's thread. Absent = no task board. */
  taskBoard?: TaskBoardCtx;
  /** Effect tools: the worker run's envelope, locations and owner gate. */
  effects?: EffectsCtx;
  /** Artifact tools: the run's channel scope. Absent = no artifact tools. */
  artifacts?: ArtifactToolCtx;
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

/** What an external server's config may use from the run (each part optional: a server needing one is skipped without it). */
export interface ExternalRunInfo {
  /** The run's own scratch dir (real path, writable by the run): a local server keeps its state here. */
  scratchDir?: string;
}

/**
 * One external (out-of-process) MCP server: a name, the tools a role may be given, and its SDK config (hosted over
 * http, or a local stdio child of the CLI). The server may expose more tools; the guard allows only the ones a role
 * lists in `mcpTools` (all of them from `tools`).
 */
export interface ExternalMcpServer {
  /** Server name (the `mcp__<name>__` prefix). */
  name: string;
  /** Bare names of the tools a role may list one by one; empty when roles are granted the whole server (`mcpServers`). */
  tools: string[];
  /** SDK connection config, or undefined when the server is not configured for this run (then it is never built). */
  config(run: ExternalRunInfo): McpHttpServerConfig | McpStdioServerConfig | undefined;
}
