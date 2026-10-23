import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import type { RoleDefinition } from "../roles/role-types";
import type { RunProtection } from "./run-protection";

/**
 * SDK permission mode of a role run. `auto` (a model classifier approves/denies each call) exists only with a real
 * Claude credential; without a real login it is not available, so the run fails closed to `default` (the guard's `ask` goes to the owner). `bypassPermissions` passes through
 * unchanged; bypass needs no auth. A protected run (a worker, or a run with a shell or an R2+ tool: `RunProtection.permissionDefault`) always runs in `default`: nothing is auto-approved
 * for it, neither by the bypass flag nor by a classifier, so a sandbox request outside its allowlist (network) is never let through
 * silently: it reaches `canUseTool`, where the guard denies it.
 */
export function resolvePermissionMode(
  role: RoleDefinition,
  config: AgentConfig,
  protection?: Pick<RunProtection, "permissionDefault">,
): PermissionMode | undefined {
  if (protection?.permissionDefault) return "default";
  if (role.permissionMode !== "auto") return role.permissionMode;
  return config.hasRealAuth ? "auto" : "default";
}

/**
 * Whether the requested SDK mode is currently in effect: for auto, the classifier decides soft guard asks; for
 * bypassPermissions, guard asks are let through. Starts as requested; the stream
 * watch (permission-watch.ts) switches it off when the SDK reports a different mode (silent fallback).
 */
export interface ModeActive {
  active: boolean;
}
