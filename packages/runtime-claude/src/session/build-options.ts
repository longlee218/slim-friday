import type { McpServerConfig, Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot, BotRuntimeSpec } from "@friday/core";
import { isInside, realOrSame } from "../floor/paths";
import { sdkEnv } from "../floor/sdk-env";
import { workerSandbox } from "../floor/worker-sandbox";
import { askOwner, PARKED_RESULT } from "./ask-question";
import type { CallGuard } from "./call-guard";
import { floorCheck } from "./floor-check";
import { mcpGranted, pickServers, splitTools } from "./mcp-grants";
import { postToolUseHook } from "./post-tool-use-hook";
import { preToolUseHook } from "./pre-tool-use-hook";
import { INTRO_TOOLS, introServers } from "./run-kind-tools";
import { buildSkillsPlugin } from "./skills-plugin";
import { systemPromptOf } from "./system-prompt";
import { toolSearchEnv, withToolSearch } from "./tool-search";

/** The SDK `query` signature; tests inject a fake. */
export type QueryFn = typeof query;

/** Settings shared by every bot the runtime opens. */
export interface ClaudeRuntimeConfig {
  /** OAuth token for the model call; absent = the SDK finds its own login. */
  oauthToken?: string;
  /** The agent's own home: no bot may read or write it. */
  agentHome: string;
  /** Parent of the per-session scratch dirs (`<scratchRoot>/<scratchName>`, see `scratch-name.ts`). */
  scratchRoot: string;
  /** Source env of the child (the caller reads it from the process; this package never does). */
  env?: Record<string, string | undefined>;
  /** MCP servers any bot may name in its tools (a function is read at every session build). */
  mcpServers?: Record<string, McpServerConfig> | (() => Record<string, McpServerConfig>);
  /** MCP servers built for one session (in-process tools that need the bot or its conversation); never shared. */
  mcpServersFor?: (spec: BotRuntimeSpec) => Record<string, McpServerConfig>;
  /** Replaces the SDK `query` (tests). */
  queryFn?: QueryFn;
  /** True when the SDK still has this session's transcript for `dir` (default: the SDK's `getSessionInfo`). */
  sessionExists?: (sessionId: string, dir: string) => Promise<boolean>;
  /**
   * Dirs the app itself grants to one bot (e.g. the Friday bot's config dir). `write` dirs are read-write, `read`
   * dirs read-only; both stay reachable even inside `agentHome`, the rest of which remains denied. `groupId` is set
   * for a group session (unset: the bot's direct session).
   */
  extraDirsFor?: (bot: Bot, groupId?: string) => { write: string[]; read: string[] };
  /** Dirs searched for `<name>/SKILL.md`, owner's first: a bot loads only the skills its `skills` list names. */
  skillDirs?: string[];
  /** Called with the summary after the main thread's context was compacted; not awaited, so it never delays the bot. */
  onCompact?: (spec: BotRuntimeSpec, summary: string) => void;
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
  /** Loop guard and tool-call cap of this session, counted in the `PreToolUse` hook. */
  guard?: CallGuard;
  /** Told the guard text when the guard stops the run (the session ends it with that text as the final). */
  onGuardStop?: (text: string) => void;
}

/**
 * SDK options for one bot session: its model, prompt, tools and background subagents, the OS sandbox around its
 * workspaces, a scrubbed env that lets background tasks run, and a permission callback that applies the hard floor
 * first and then asks `spec.decide` (a throw or a refusal is a deny; a park is a deny that ends the turn).
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
  const extra = config.extraDirsFor?.(bot, spec.groupId) ?? { write: [], read: [] };
  const writePaths = [...bot.workspaces, ...extra.write];
  const readPaths = [...writePaths, ...extra.read];
  const floor = {
    writePaths: [...writePaths, scratchDir],
    readPaths: [...readPaths, scratchDir],
    agentHome: config.agentHome,
    cwd,
    allowInside: [scratchDir, ...extra.write, ...extra.read],
  };
  // An intro run has its own fixed tool list (no bot tools, subagents, skills or other servers).
  const intro = spec.runKind === "intro";
  const { builtIn: granted, mcp } = splitTools(intro ? INTRO_TOOLS : bot.tools);
  // Tool search needs the built-in `ToolSearch` listed (spike); an intro run keeps its fixed list as it is.
  const search = spec.toolSearch ?? "on";
  const builtIn = withToolSearch(granted, search, intro);
  const perSession = introServers(intro, config.mcpServersFor?.(spec) ?? {});
  // A function is read at every session build, so an edited config reaches the next session.
  const configured =
    typeof config.mcpServers === "function" ? config.mcpServers() : (config.mcpServers ?? {});
  const mcpServers = pickServers(mcp, configured, perSession);
  // Skills come only from the bot's own list, as a plugin built in its scratch dir (no settings sources are read).
  const skillsPlugin =
    bot.skills.length && !intro
      ? buildSkillsPlugin(scratchDir, config.skillDirs ?? [], bot.skills)
      : undefined;
  const agents = Object.fromEntries(
    (intro ? [] : bot.subagents).map((s) => [
      s.name,
      {
        description: s.description,
        prompt: s.prompt,
        tools: s.tools,
        ...(s.model && { model: s.model }),
        ...(s.effort && { effort: s.effort }),
        background: true,
      },
    ]),
  );
  return {
    model: bot.model,
    ...(bot.effort && { effort: bot.effort }),
    systemPrompt: systemPromptOf(spec, scratchDir),
    cwd,
    additionalDirectories: [...bot.workspaces.slice(1), ...extra.write, ...extra.read],
    tools: skillsPlugin && !builtIn.includes("Skill") ? [...builtIn, "Skill"] : builtIn,
    ...(skillsPlugin && {
      plugins: [{ type: "local" as const, path: skillsPlugin.path }],
      skills: skillsPlugin.skills,
    }),
    agents,
    settingSources: [],
    permissionMode: "default",
    abortController: input.abort,
    ...(input.resume && { resume: input.resume }),
    ...(input.sessionId && { sessionId: input.sessionId }),
    ...(Object.keys(mcpServers).length && { mcpServers }),
    env: {
      ...sdkEnv(
        { hasRealAuth: !!config.oauthToken, oauthToken: config.oauthToken },
        config.env ?? {},
        { worker: true, allowBackground: true, subagentDepth: 1 },
      ),
      ...toolSearchEnv(search),
    },
    sandbox: workerSandbox({
      writePaths,
      readPaths,
      cwd,
      scratchDir,
      denyPaths: [config.agentHome],
      allowInside: [scratchDir, ...extra.write, ...extra.read],
    }),
    // The CLI auto-allows reads inside the cwd and extra dirs without calling `canUseTool`; a hook runs for every call,
    // so the floor holds there too (and for Glob / Grep with no path); the call guard counts there too.
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook(floor, input.guard, input.onGuardStop)] }],
      // Clips an external MCP result over 12 000 chars (Friday's own tools clip when they build the result).
      PostToolUse: [{ hooks: [postToolUseHook()] }],
      PostCompact: [
        {
          hooks: [
            async (hook) => {
              // A subagent's compaction (agent_id set) is not the bot's own conversation.
              if (hook.hook_event_name === "PostCompact" && !hook.agent_id && config.onCompact) {
                try {
                  config.onCompact(spec, hook.compact_summary);
                } catch {
                  // A failing flush must never break the session.
                }
              }
              return { continue: true };
            },
          ],
        },
      ],
    },
    async canUseTool(tool, toolInput, opts) {
      // A question for the owner comes first: it is no grant and no file access.
      if (tool === "AskUserQuestion") return askOwner(spec, toolInput);
      if (intro && !INTRO_TOOLS.includes(tool))
        return { behavior: "deny", message: "tool not available in this run" };
      if (!mcpGranted(tool, mcp, Object.keys(perSession)))
        return { behavior: "deny", message: "tool not granted to this bot" };
      const denied = floorCheck({ tool, input: toolInput }, floor);
      if (denied) return { behavior: "deny", message: denied };
      try {
        const d = await spec.decide({ tool, input: toolInput, taskId: opts.agentID });
        if (d.behavior === "allow") return { behavior: "allow", updatedInput: toolInput };
        // Parked on a card: the tool does not run and the turn ends (the engine closes the session).
        if (d.behavior === "park") return PARKED_RESULT;
        return { behavior: "deny", message: d.reason };
      } catch {
        return { behavior: "deny", message: "permission decision failed" };
      }
    },
  };
}
