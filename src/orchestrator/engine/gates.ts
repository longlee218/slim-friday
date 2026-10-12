import type { Gate, RoleDefinition, StageDefinition } from "../../roles/role-types";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../../tools/sdk-tool-names";

/* The gate table: the one place that says what each owner gate looks like. Import-light on purpose (the thread
   state reads it); the plan-approval run is in plan-run.ts. */

/** `approvals.tool` label of the owner-confirm gate (asked inline by owner-confirm.ts: effort `max`, `ESCALATE: opus`). */
export const OWNER_CONFIRM_APPROVAL = "OwnerConfirm";

/** Thread states a waiting gate puts the thread in. */
export type GateState = "awaiting_plan_approval" | "awaiting_confirmation";

/** Per gate: the `approvals.tool` label its pending approval carries, and the thread state while it waits. */
export const GATES: Record<Exclude<Gate, "none">, { tool: string; state: GateState }> = {
  "plan-approval": { tool: EXIT_PLAN_MODE_TOOL_NAME, state: "awaiting_plan_approval" },
  "owner-confirm": { tool: OWNER_CONFIRM_APPROVAL, state: "awaiting_confirmation" },
};

/** Thread state of a pending approval, by its `approvals.tool` label; undefined = not a gate approval. */
export const stateOfApprovalTool = (tool: string): GateState | undefined =>
  Object.values(GATES).find((g) => g.tool === tool)?.state;

/** Thread state while `gate` waits; undefined for no gate. */
export const stateOfGate = (gate: Gate | undefined): GateState | undefined =>
  gate && gate !== "none" ? GATES[gate].state : undefined;

/**
 * How the engine runs a stage, from its data: `plan` (gate plan-approval), `repo` (no gate, `write` capability: the
 * agent works in the approved repo's checkout and delivers itself), `plain` (no gate, no `write`: read-only run
 * over the registered repos). Anything else (e.g. owner-confirm, which has no implementation yet) is
 * `unsupported`: the runner fails closed.
 */
export type StageKind = "plan" | "repo" | "plain" | "unsupported";

/** Some stage of the role runs in the repo (`stageKind` = `repo`): the side lane must not run it. */
export const runsInRepo = (role: RoleDefinition): boolean =>
  role.stages.some((s) => stageKind(s) === "repo");

export function stageKind(stage: StageDefinition): StageKind {
  const gate = stage.gate ?? "none";
  if (gate === "plan-approval") return "plan";
  if (gate !== "none") return "unsupported";
  return stage.capabilities.includes("write") ? "repo" : "plain";
}
