import type { RiskClass } from "../policy/risk-types";
import { TOOL_BY_ID } from "./tool-catalog-entries";
import type { ToolRunKind } from "./tool-decl";

/** What a run may do, derived from the ids of its tools. Every capability check of the engine reads this. */
export interface ToolPolicy {
  /** The valid ids it was derived from (SDK groups and MCP tool names). */
  ids: ReadonlySet<string>;
  /** SDK built-in tools (the SDK `tools` option): the groups' tools, plus the subagent tools when the run may spawn. */
  sdkTools: string[];
  /** Bare names of the MCP tools. */
  mcpTools: string[];
  /** SDK tools the guard lets through without asking. */
  autoAllow: string[];
  /** SDK tools a subagent of the run may call. */
  subagentTools: string[];
  shell: boolean;
  write: boolean;
  readLocations: boolean;
  effects: boolean;
  scratch: boolean;
  /** Highest risk class among the tools. */
  maxRisk: RiskClass;
  /** Prompt clauses of the tools that have one. */
  clauses: string[];
}

const RISK_ORDER: readonly RiskClass[] = ["R0", "R1", "R2", "R3", "R4"];

/** Ids that are not in the catalog; startup refuses a role or teammate that lists one. */
export function validateToolIds(ids: readonly string[]): void {
  const unknown = ids.filter((id) => !TOOL_BY_ID.has(id));
  if (unknown.length) throw new Error(`Unknown tool id: ${unknown.join(", ")}`);
}

/** Ids a run of `kind` cannot build (its ctx part is missing). Throws naming them. */
export function validateForKind(ids: readonly string[], kind: ToolRunKind): void {
  validateToolIds(ids);
  const bad = ids.filter((id) => !TOOL_BY_ID.get(id)?.runKinds.includes(kind));
  if (bad.length) throw new Error(`Tool not available to a ${kind} run: ${bad.join(", ")}`);
}

/**
 * The policy of a run from its tool ids. `subagents`: the run may spawn SDK subagents (the group's tools are added
 * once, after the listed groups, whether or not the ids list it). Order of every list follows `ids`, deduplicated.
 */
export function derivePolicy(
  ids: readonly string[],
  o: { runKind: ToolRunKind; subagents: boolean },
): ToolPolicy {
  validateForKind(ids, o.runKind);
  const decls = [...new Set(ids)].map((id) => TOOL_BY_ID.get(id));
  const sdkDecls = decls.filter((d) => d?.sdkTools);
  const subagentGroup = TOOL_BY_ID.get("subagents");
  const sdkTools = [
    ...new Set([
      ...sdkDecls.flatMap((d) => d?.sdkTools ?? []),
      ...(o.subagents ? (subagentGroup?.sdkTools ?? []) : []),
    ]),
  ];
  const auto = new Set<string>();
  for (const d of [...sdkDecls, ...(o.subagents && subagentGroup ? [subagentGroup] : [])])
    if (d?.autoAllow) for (const t of d.sdkTools ?? []) if (!d.askTools?.includes(t)) auto.add(t);
  const needs = new Set(decls.flatMap((d) => d?.needs ?? []));
  const risks = decls.map((d) => RISK_ORDER.indexOf(d?.risk ?? "R0"));
  return {
    ids: new Set(ids),
    sdkTools,
    mcpTools: decls.flatMap((d) => (d?.mcpTool ? [d.mcpTool] : [])),
    autoAllow: sdkTools.filter((t) => auto.has(t)),
    subagentTools: [
      ...new Set(decls.filter((d) => d?.subagentUsable).flatMap((d) => d?.sdkTools ?? [])),
    ],
    shell: needs.has("shell"),
    write: needs.has("location.write"),
    readLocations: needs.has("location.read"),
    effects: needs.has("effects"),
    scratch: needs.has("scratch"),
    maxRisk: RISK_ORDER[Math.max(0, ...risks)] ?? "R0",
    clauses: decls.flatMap((d) => (d?.promptClause ? [d.promptClause] : [])),
  };
}
