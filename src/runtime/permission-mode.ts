import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import type { StageDefinition } from "../roles/role-types";

/**
 * SDK permission mode of a stage run. `auto` (a model classifier approves/denies each call) exists only on the
 * Anthropic path with a real Claude credential; on OpenRouter or without a real login it is not available, so
 * the stage fails closed to `default` (the guard's `ask` goes to the owner). Other modes (plan, bypassPermissions)
 * pass through unchanged; bypass needs no auth.
 */
export function resolvePermissionMode(
  stage: StageDefinition,
  config: AgentConfig,
): PermissionMode | undefined {
  if (stage.permissionMode !== "auto") return stage.permissionMode;
  return config.provider === "anthropic" && config.hasRealAuth ? "auto" : "default";
}

/**
 * Whether the requested SDK mode is currently in effect: for auto, the classifier decides soft guard asks; for
 * bypassPermissions, guard asks are let through. Starts as requested; the stream
 * watch (permission-watch.ts) switches it off when the SDK reports a different mode (silent fallback).
 */
export interface ModeActive {
  active: boolean;
}
