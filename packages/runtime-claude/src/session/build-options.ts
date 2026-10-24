import type { McpServerConfig, Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, BotRuntimeSpec } from "@friday/core";
import { isInside, realOrSame } from "../floor/paths";
import { sdkEnv } from "../floor/sdk-env";
import { workerSandbox } from "../floor/worker-sandbox";
import { floorCheck } from "./floor-check";
import { mcpGranted, pickServers, splitTools } from "./mcp-grants";

/** The SDK `query` signature; tests inject a fake. */
export type QueryFn = typeof query;

/** Settings shared by every bot the runtime opens. */
export interface ClaudeRuntimeConfig {
  /** OAuth token for the model call; absent = the SDK finds its own login. */
  oauthToken?: string;
  /** The agent's own home: no bot may read or write it. */
  agentHome: string;
  /** Parent of the per-bot scratch dirs (`<scratchRoot>/<bot id>`). */
  scratchRoot: string;
  /** Source env of the child (the caller reads it from the process; this package never does). */
  env?: Record<string, string | undefined>;
  /** MCP servers any bot may name in its tools. */
  mcpServers?: Record<string, McpServerConfig>;
  /** MCP servers built for one session (in-process tools that need the bot or its conversation); never shared. */
  mcpServersFor?: (spec: BotRuntimeSpec) => Record<string, McpServerConfig>;
  /** Replaces the SDK `query` (tests). */
  queryFn?: QueryFn;
  /** True when the SDK still has this session's transcript for `dir` (default: the SDK's `getSessionInfo`). */
  sessionExists?: (sessionId: string, dir: string) => Promise<boolean>;
  /**
   * Dirs the app itself grants to one bot (e.g. the Friday bot's config dir). `write` dirs are read-write, `read`
   * dirs read-only; both stay reachable even inside `agentHome`, the rest of which remains denied.
   */
  extraDirsFor?: (bot: Bot) => { write: string[]; read: string[] };
}

/** What `buildOptions` needs for one session. */
export interface BuildOptionsInput {
  spec: BotRuntimeSpec;
  config: ClaudeRuntimeConfig;
  /** Session id to resume. */
  resume?: string;
  /** Id a NEW session gets (a UUID); not used together with `resume`. */
  sessionId?: string;
  abort: AbortController;
  /** The bot's scratch dir (always writable, cwd when the bot has no workspace). */
  scratchDir: string;
}

/**
 * SDK options for one bot session: its model, prompt, tools and background subagents, the OS sandbox around its
 * workspaces, a scrubbed env that lets background tasks run, and a permission callback that applies the hard floor
 * first and then asks `spec.decide` (a throw or a refusal is a deny).
 */
export function buildOptions(input: BuildOptionsInput): Options {
  const { spec, config, scratchDir } = input;
  const { bot } = spec;
  const cwd = bot.workspaces[0] ?? scratchDir;
  // A workspace inside the agent home would hand the bot's shell the engine db or the config.
  const realHome = realOrSame(config.agentHome);
  for (const w of bot.workspaces)
    if (isInside(realHome, realOrSame(w)))
      throw new Error(`workspace ${w} is inside the agent home`);
  const extra = config.extraDirsFor?.(bot) ?? { write: [], read: [] };
  const writePaths = [...bot.workspaces, ...extra.write];
  const readPaths = [...writePaths, ...extra.read];
  const floor = {
    writePaths: [...writePaths, scratchDir],
    readPaths: [...readPaths, scratchDir],
    agentHome: config.agentHome,
    cwd,
    allowInside: [scratchDir, ...extra.write, ...extra.read],
  };
  const { builtIn, mcp } = splitTools(bot.tools);
  const perSession = config.mcpServersFor?.(spec) ?? {};
  const mcpServers = pickServers(mcp, config.mcpServers ?? {}, perSession);
  const agents = Object.fromEntries(
    bot.subagents.map((s) => [
      s.name,
      {
        description: s.description,
        prompt: s.prompt,
        tools: s.tools,
        ...(s.model && { model: s.model }),
        background: true,
      },
    ]),
  );
  return {
    model: bot.model,
    systemPrompt: `You are ${bot.name}, ${bot.title}.\n\n${bot.instructions}`,
    cwd,
    additionalDirectories: [...bot.workspaces.slice(1), ...extra.write, ...extra.read],
    tools: builtIn,
    agents,
    settingSources: [],
    permissionMode: "default",
    abortController: input.abort,
    ...(input.resume && { resume: input.resume }),
    ...(input.sessionId && { sessionId: input.sessionId }),
    ...(Object.keys(mcpServers).length && { mcpServers }),
    env: sdkEnv(
      { hasRealAuth: !!config.oauthToken, oauthToken: config.oauthToken },
      config.env ?? {},
      { worker: true, allowBackground: true, subagentDepth: 1 },
    ),
    sandbox: workerSandbox({
      writePaths,
      readPaths,
      cwd,
      scratchDir,
      denyPaths: [config.agentHome],
      allowInside: [scratchDir, ...extra.write, ...extra.read],
    }),
    // The CLI auto-allows reads inside the cwd and extra dirs without calling `canUseTool`; a hook runs for every call,
    // so the floor holds there too (and for Glob / Grep with no path).
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hook) => {
              if (hook.hook_event_name !== "PreToolUse") return { continue: true };
              const reason = floorCheck(
                { tool: hook.tool_name, input: (hook.tool_input ?? {}) as Record<string, unknown> },
                floor,
              );
              return reason
                ? {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: reason,
                    },
                  }
                : { continue: true };
            },
          ],
        },
      ],
    },
    async canUseTool(tool, toolInput, opts) {
      if (!mcpGranted(tool, mcp, Object.keys(perSession)))
        return { behavior: "deny", message: "tool not granted to this bot" };
      const denied = floorCheck({ tool, input: toolInput }, floor);
      if (denied) return { behavior: "deny", message: denied };
      try {
        const d = await spec.decide({ tool, input: toolInput, taskId: opts.agentID });
        return d.behavior === "allow"
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: d.reason };
      } catch {
        return { behavior: "deny", message: "permission decision failed" };
      }
    },
  };
}
