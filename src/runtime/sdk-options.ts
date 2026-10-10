import type { HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { effortKnobs } from "../config/effort-mapping";
import { type Route, resolveBudget, resolveModel, safeEffort } from "../config/model-routing";
import { mcpServersFor } from "../mcp/mcp-servers";
import type { RunRecorder } from "../observability/record-run";
import { buildToolHooks, hookOptions } from "../observability/tool-hooks";
import { roleOfStage } from "../roles/role-registry";
import type { StageDefinition } from "../roles/role-types";
import { SUBAGENTS, toolOptions } from "../tools/tool-catalog";
import type { RunAgentInput } from "./run-agent";
import { sdkEnv } from "./sdk-env";
import { buildSystemPrompt } from "./system-prompt";
import { buildToolPermissions } from "./tool-permissions";
import type { RunSkills } from "./workspace-skills-plugin";

/**
 * Config of the stage run: `model` and `limits.maxBudgetUsd` replaced by the stage's own (tier routing and
 * per-stage budget, see model-routing.ts), so everything downstream (SDK env, runs row, options) reads one place.
 */
export function stageConfig(
  stage: StageDefinition,
  config: AgentConfig,
  route: Route = {},
): AgentConfig {
  const role = roleOfStage(stage);
  return {
    ...config,
    model: resolveModel(stage, role, route, config),
    limits: { ...config.limits, maxBudgetUsd: resolveBudget(stage, role, route, config) },
  };
}

/** Run timeout of the stage: never below the config's; stages with owner gates include approval waits. */
export const stageTimeoutMs = (stage: StageDefinition, config: AgentConfig): number =>
  Math.max(config.limits.timeoutMs, stage.timeoutMs ?? 0);

/** Put the guardrail PreToolUse matchers before the recording hooks (deny must win early). */
function mergeHooks(
  rec: ReturnType<typeof buildToolHooks>,
  guard: HookCallbackMatcher[] | undefined,
): ReturnType<typeof buildToolHooks> {
  if (!guard) return rec;
  return { ...rec, PreToolUse: [...guard, ...(rec.PreToolUse ?? [])] };
}

/**
 * The SDK `Options` of one run, derived from the stage (tools, git groups, permission mode, subagents,
 * handoff server, prompt) and the run input (paths, context, resume). `config` is already the stage's
 * (see `stageConfig`). Only the MCP server start is async; no I/O else happens here.
 */
export async function buildSdkOptions(
  stage: StageDefinition,
  input: RunAgentInput,
  deps: {
    config: AgentConfig;
    recorder: RunRecorder;
    skills: RunSkills;
  },
): Promise<Options> {
  const { config, skills: sk } = deps;
  const effort = input.route && safeEffort(input.route);
  // Every stage goes through the permission layer when it has a guard (a stage without a gateway: ask = deny).
  // This run's plugin dir (and only it) becomes READABLE so skills can open their bundled files.
  const guard =
    input.guard?.readPaths && sk.dirs.length
      ? { ...input.guard, readPaths: [...input.guard.readPaths, ...sk.dirs] }
      : input.guard;
  const perms = guard
    ? buildToolPermissions({
        ...input.code, // gateway, plan, askLimit, onAskTimeout
        taskId: input.taskId,
        threadId: input.code?.threadId ?? "",
        guard,
      })
    : undefined;
  return {
    cwd: input.cwd,
    ...(input.additionalDirectories?.length && {
      additionalDirectories: input.additionalDirectories,
    }),
    model: config.model,
    resume: input.resume,
    ...toolOptions(stage),
    mcpServers: await mcpServersFor(stage, input),
    ...(stage.permissionMode && { permissionMode: stage.permissionMode }),
    ...(perms && { canUseTool: perms.canUseTool }),
    // Only the subagents this stage names (read-only tools each). Skills: only the workspace's curated ones,
    // through the plugin; the list hides the SDK's bundled ones (a model once reached for `update-config`).
    agents: Object.fromEntries(
      Object.entries(SUBAGENTS).filter(([name]) => stage.subagents?.includes(name)),
    ),
    skills: sk.skills,
    ...(sk.plugins && { plugins: sk.plugins }),
    maxTurns: config.limits.maxTurns,
    // Effort (when the orchestrator passes one) sets thinking and scales maxTurns; otherwise SDK defaults.
    ...(effort && effortKnobs(effort, config.limits.maxTurns)),
    // Stage budget (already capped by MAX_BUDGET_USD in `stageConfig`); omitted on openrouter without the cap.
    ...(config.limits.maxBudgetUsd !== undefined && { maxBudgetUsd: config.limits.maxBudgetUsd }),
    abortController: input.abortController,
    // No filesystem settings in any stage: no repo (or ancestor) CLAUDE.md, no repo hooks/settings. Friday's
    // persona, AGENTS.md and memory are the only instructions; the exec worktree is agent-writable anyway.
    settingSources: [],
    systemPrompt: buildSystemPrompt(
      (input.extraContext ?? []).filter(Boolean).join("\n\n"),
      stage,
      {
        handoff: !!input.appServer,
        workflow: input.workflow,
        escalation: !!input.route?.offerEscalation,
      },
    ),
    hooks: mergeHooks(
      buildToolHooks(deps.recorder, hookOptions(perms, config, input)),
      perms?.hooks,
    ),
    env: sdkEnv(config),
  };
}
