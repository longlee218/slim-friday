import type { Gate, StageDefinition } from "../../roles/role-types";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../../tools/sdk-tool-names";

/* The gate table: the one place that says what each owner gate looks like. Import-light on purpose (the thread
   state reads it); the plan-approval run is in plan-run.ts and the delivery offer in outputs/pr-output.ts. */

/** `approvals.tool` label of the PR confirmation (persisted in `approvals.tool`, not an SDK tool). */
export const CREATE_PR_APPROVAL = "CreatePR";

/** `approvals.tool` label of the owner-confirm gate (no stage uses it yet: vocabulary only). */
export const OWNER_CONFIRM_APPROVAL = "OwnerConfirm";

/** Thread states a waiting gate puts the thread in. */
export type GateState = "awaiting_plan_approval" | "awaiting_result" | "awaiting_confirmation";

/** Per gate: the `approvals.tool` label its pending approval carries, and the thread state while it waits. */
export const GATES: Record<Exclude<Gate, "none">, { tool: string; state: GateState }> = {
  "plan-approval": { tool: EXIT_PLAN_MODE_TOOL_NAME, state: "awaiting_plan_approval" },
  delivery: { tool: CREATE_PR_APPROVAL, state: "awaiting_result" },
  "owner-confirm": { tool: OWNER_CONFIRM_APPROVAL, state: "awaiting_confirmation" },
};

/** Thread state of a pending approval, by its `approvals.tool` label; undefined = not a gate approval. */
export const stateOfApprovalTool = (tool: string): GateState | undefined =>
  Object.values(GATES).find((g) => g.tool === tool)?.state;

/** Thread state while `gate` waits; undefined for no gate. */
export const stateOfGate = (gate: Gate | undefined): GateState | undefined =>
  gate && gate !== "none" ? GATES[gate].state : undefined;

/**
 * How the engine runs a stage, from its data: `plan` (gate plan-approval, no isolation), `clone` (isolated
 * checkout; a delivery gate follows), `plain` (read-only run over the registered repos, no gate). Anything
 * else (e.g. owner-confirm, which has no implementation yet) is `unsupported`: the runner fails closed.
 */
export type StageKind = "plan" | "clone" | "plain" | "unsupported";

export function stageKind(stage: StageDefinition): StageKind {
  const gate = stage.gate ?? "none";
  const iso = stage.isolation ?? "none";
  if (iso === "none" && gate === "plan-approval") return "plan";
  if (iso === "clone" && (gate === "delivery" || gate === "none")) return "clone";
  if (iso === "none" && gate === "none") return "plain";
  return "unsupported";
}
