import type { RiskClass } from "../policy/risk-types";

/**
 * What a tool needs from the run around it. The run's protection (OS sandbox, path guard, approvals) is derived from
 * the needs of its tools, never from "this run has an envelope".
 */
export type ToolNeed =
  | "location.read" // reads files of the granted locations
  | "location.write" // changes files of the granted locations
  | "shell" // Bash (bounded by the OS sandbox)
  | "scratch" // the run's own scratch dir
  | "effects"; // an effect tool: delete / push / PR / merge, behind the owner's approval

/**
 * Kinds of run a tool can be BUILT in: the kind must bring the ctx part the tool reads (`src/mcp/manifest-types.ts`).
 * `worker` = a dispatched item, `teammate` = the engine run of a channel.
 */
export type ToolRunKind = "worker" | "teammate";

/** One assignable tool: the unit a role or teammate lists, with the facts the engine derives its policy from. */
export interface ToolDecl {
  /** Id a role lists: an SDK group (`read`, `shell`...) or the bare name of an MCP tool (its `constants.ts`). */
  id: string;
  /** SDK built-in tools the id enables (`sdk-tool-names.ts`). */
  sdkTools?: readonly string[];
  /** Bare MCP tool name; its server is `MCP_TOOL_SERVER`. */
  mcpTool?: string;
  /** The tool never changes anything. Informational: the guard's allow list is `autoAllow`. */
  readOnly: boolean;
  /**
   * Effect risk class. Tools the classifier knows (reads R0, writes R1, effect tools R2/R3) carry its class
   * (test); every other tool is R0 (read only) or R1 (changes app state or runs sandbox-bounded). Only an effect tool
   * is R2 or above.
   */
  risk: RiskClass;
  /** What the run must provide for the tool. */
  needs: readonly ToolNeed[];
  /** Run kinds that can build the tool. */
  runKinds: readonly ToolRunKind[];
  /** SDK tools of the group the guard lets through without asking (the group's other tools go through checks). */
  autoAllow?: boolean;
  /** Tools of an auto-allowed group that still ask (TaskStop takes any task id). */
  askTools?: readonly string[];
  /** A subagent may call the tools of this group (files, shell, web, skills). */
  subagentUsable?: boolean;
  /** Prompt text a prompt may render for the tool (used by the presets, phase 02). */
  promptClause?: string;
}
