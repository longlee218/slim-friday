import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { type Route, resolveBudget } from "../config/model-routing";
import { pinnedBinaryEnv } from "../config/pinned-binaries";
import { readProcessEnv } from "../config/process-env";
import { buildServers } from "../mcp/mcp-servers";
import type { RunRecorder } from "../observability/record-run";
import { buildToolHooks, hookOptions } from "../observability/tool-hooks";
import type { RoleDefinition } from "../roles/role-types";
import { toolOptions } from "../tools/tool-catalog";
import { buildCompactHooks } from "./compact-hooks";
import { type ModeActive, resolvePermissionMode } from "./permission-mode";
import type { RunAgentInput } from "./run-agent";
import { sdkEnv } from "./sdk-env";
import type { RunSkills } from "./skills-plugin/plugin-builder";
import { buildSystemPrompt } from "./system-prompt";
import { buildToolPermissions } from "./tool-permissions";
import { workerSandbox } from "./worker-sandbox";

/**
 * Config of the role run: `model` and `limits.maxBudgetUsd` replaced by the role's own (its fixed model and
 * per-role budget, see model-routing.ts), so everything downstream (SDK env, runs row, options) reads one place.
 */
export function roleConfig(
  role: RoleDefinition,
  config: AgentConfig,
  route: Route = {},
): AgentConfig {
  return {
    ...config,
    model: role.model,
    limits: { ...config.limits, maxBudgetUsd: resolveBudget(role, route, config) },
  };
}

/**
 * Put the guardrail PreToolUse matchers before the recording hooks (deny must win early); the guard's Post hooks (free
 * a subagent slot) go after the recording ones.
 */
function mergeHooks(
  rec: ReturnType<typeof buildToolHooks>,
  perms: ReturnType<typeof buildToolPermissions> | undefined,
): ReturnType<typeof buildToolHooks> {
  if (!perms) return rec;
  const post = (e: "PostToolUse" | "PostToolUseFailure") => [
    ...(rec[e] ?? []),
    ...(perms.postHooks[e] ?? []),
  ];
  return {
    ...rec,
    PreToolUse: [...perms.hooks, ...(rec.PreToolUse ?? [])],
    PostToolUse: post("PostToolUse"),
    PostToolUseFailure: post("PostToolUseFailure"),
    PermissionDenied: [
      ...(rec.PermissionDenied ?? []),
      ...(perms.postHooks.PermissionDenied ?? []),
    ],
  };
}

/**
 * The SDK `Options` of one run, derived from the role (tools, git groups, permission mode,
 * prompt) and the run input (paths, context, resume). `config` is already the role's
 * (see `roleConfig`). No I/O happens here.
 */
export function buildSdkOptions(
  role: RoleDefinition,
  input: RunAgentInput,
  deps: {
    config: AgentConfig;
    recorder: RunRecorder;
    skills: RunSkills;
    /** Shared with the stream watch: flips off when the SDK did not enter the requested auto mode. */
    autoState: ModeActive;
    /** Same for bypassPermissions (the developer role). */
    bypassState: ModeActive;
    /** Collects the Skill tool calls of the run (`skills.used`). */
    skillsCalled?: Set<string>;
  },
): Options {
  const { config, skills: sk } = deps;
  // Every run goes through the permission layer when it has a guard (a run without a gateway: ask = deny).
  // This run's plugin dirs (and only them) become READABLE so skills can open their bundled files.
  // Skill plugin dirs may sit under the denied AGENT_HOME: the run's own ones stay usable (`allowInside`), even
  // for a role without a readPaths limit.
  const withSkills =
    input.guard && sk.dirs.length
      ? {
          ...input.guard,
          ...(input.guard.readPaths && { readPaths: [...input.guard.readPaths, ...sk.dirs] }),
          allowInside: [...(input.guard.allowInside ?? []), ...sk.dirs],
          skillDirs: [...(input.guard.skillDirs ?? []), ...sk.dirs],
        }
      : input.guard;
  // The role's pinned binaries (verified by sha256): env vars for the run, readable by its sandboxed shell. Only a run with
  // its own scratch dir (a dispatched worker) gets them.
  const bins = pinnedBinaryEnv(role.binaries, input.guard?.envelope?.goalDir);
  const guard =
    withSkills && bins.paths.length ? { ...withSkills, binaryPaths: bins.paths } : withSkills;
  const sandbox = config.sandboxOff ? undefined : workerSandbox(guard); // FRIDAY_SANDBOX_OFF: owner switch
  const permissionMode = resolvePermissionMode(role, config, input.guard);
  const perms = guard
    ? buildToolPermissions({
        ...input.code, // gateway, askLimit, onAskTimeout
        turnId: input.turnId,
        threadId: input.code?.threadId ?? "",
        guard,
        runSignal: input.abortController.signal,
        onGuardDecision: (e) => {
          input.onToolStart?.();
          if (e.decision === "deny")
            input.onControlEvent?.({ kind: "guard_denied", tool: e.tool, reasonCode: "guard" });
        },
        autoMode: deps.autoState,
        bypassMode: deps.bypassState,
        onDeny: (id) => deps.recorder.denied.add(id),
        maxSubagents: role.subagents.parallel,
      })
    : undefined;
  return {
    cwd: input.cwd,
    ...(input.additionalDirectories?.length && {
      additionalDirectories: input.additionalDirectories,
    }),
    model: config.model,
    resume: input.resume,
    ...toolOptions(role),
    // A local external server keeps its state in the run's own scratch dir (a worker with an envelope).
    mcpServers: buildServers(
      role,
      { ...input.appCtx?.(), memory: input.memory },
      { scratchDir: input.guard?.envelope?.goalDir },
    ),
    ...(permissionMode && { permissionMode }),
    // The SDK refuses bypassPermissions without this explicit opt-in (the guard hook stays the gate).
    ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    ...(perms && { canUseTool: perms.canUseTool }),
    // No `agents` option: the app defines no subagent types, the SDK's built-in one is what the Agent tool starts.
    // Skills: only the plugins' (publisher + workspace); the list hides the SDK's bundled ones (a model once reached
    // for `update-config`).
    skills: sk.skills,
    ...(sk.plugins && { plugins: sk.plugins }),
    // The role's own agent-loop ceiling (`limits.maxTurns`).
    maxTurns: role.limits.maxTurns,
    // The role's fixed thinking config; omitted = the SDK default.
    ...(role.thinking && { thinking: role.thinking }),
    // Role budget (already capped by MAX_BUDGET_USD in `roleConfig`).
    ...(config.limits.maxBudgetUsd !== undefined && { maxBudgetUsd: config.limits.maxBudgetUsd }),
    abortController: input.abortController,
    // Streaming input: the CLI echoes each consumed user message (isReplay): the proof a steer was read (steered-stream.ts).
    ...(input.steer && { extraArgs: { "replay-user-messages": null } }),
    // No filesystem settings in any run: no location (or ancestor) CLAUDE.md, no location hooks/settings. Friday's
    // persona, AGENTS.md and memory are the only instructions.
    settingSources: [],
    // SDK context that competes with ours: its file memory (MemorySave is the app's), its commit / PR instructions and the
    // Co-Authored-By attribution reminder (commits are made as the owner). Verified by a capture of the real request.
    settings: {
      autoMemoryEnabled: false,
      includeGitInstructions: false,
      attribution: { commit: "", pr: "" },
    },
    // A dispatched worker's shell runs in an OS sandbox (writes only in its dirs, network open); see worker-sandbox.ts.
    ...(sandbox && { sandbox }),
    systemPrompt: buildSystemPrompt((input.extraContext ?? []).filter(Boolean).join("\n\n"), role),
    hooks: {
      ...mergeHooks(
        buildToolHooks(deps.recorder, hookOptions(perms, config, input, deps.skillsCalled)),
        perms,
      ),
      // Compaction hooks (journal extract + thread summary) need the thread: runs without a memory context have none.
      ...(input.memory?.threadId &&
        buildCompactHooks({ ...input.memory, threadId: input.memory.threadId })),
    },
    env: {
      ...sdkEnv(config, readProcessEnv(), {
        worker: !!guard?.envelope,
        subagentDepth: role.subagents.depth,
      }),
      ...bins.env,
    },
  };
}
