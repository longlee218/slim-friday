import type { McpServerConfig, Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { BotRuntimeSpec } from "@friday/core";
import { sdkEnv } from "../floor/sdk-env";
import { workerSandbox } from "../floor/worker-sandbox";
import { floorCheck } from "./floor-check";

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
  /** Replaces the SDK `query` (tests). */
  queryFn?: QueryFn;
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
  const writePaths = [...bot.workspaces];
  const floor = {
    writePaths: [...writePaths, scratchDir],
    readPaths: [...writePaths, scratchDir],
    agentHome: config.agentHome,
    cwd,
    allowInside: [scratchDir],
  };
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
    additionalDirectories: bot.workspaces.slice(1),
    tools: bot.tools,
    agents,
    settingSources: [],
    permissionMode: "default",
    abortController: input.abort,
    ...(input.resume && { resume: input.resume }),
    ...(input.sessionId && { sessionId: input.sessionId }),
    ...(config.mcpServers && { mcpServers: config.mcpServers }),
    env: sdkEnv(
      { hasRealAuth: !!config.oauthToken, oauthToken: config.oauthToken },
      config.env ?? {},
      { worker: true, allowBackground: true, subagentDepth: 1 },
    ),
    sandbox: workerSandbox({
      writePaths,
      readPaths: writePaths,
      cwd,
      scratchDir,
      denyPaths: [config.agentHome],
      allowInside: [scratchDir],
    }),
    async canUseTool(tool, toolInput, opts) {
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
