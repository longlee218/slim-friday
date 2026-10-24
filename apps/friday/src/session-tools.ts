import { relative } from "node:path";
import type { BotRuntimeSpec, Store } from "@friday/core";
import {
  EFFECTS_MCP_SERVER,
  type EffectsContext,
  effectsServer,
  type FileMemory,
  MEMORY_MCP_SERVER,
  memoryServer,
  type ToolSessionContext,
} from "@friday/tools";

/** Longest a git or gh command of an effect tool may run. */
const RUN_TIMEOUT_MS = 120_000;

/** What the per-session tools are built from. */
export interface SessionToolsDeps {
  memory: FileMemory;
  store: Pick<Store, "conversations" | "groups">;
  /** The agent home (the trash lives under it). */
  home: string;
  /** Where `CreateProject` makes repos (read per session, so a settings change applies to new sessions). */
  projectsDir: () => string;
  /** True for a sensitive path relative to its workspace (`.env`, keys...). */
  isSensitive: (rel: string) => boolean;
  /** Runs a command (argv, no shell); tests replace it. */
  run?: EffectsContext["run"];
}

/** Run argv in `cwd` with a timeout; stdout and stderr are returned together. */
async function runCommand(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: out + err };
}

/** What the tools of one session know: the bot, the conversation it answers now, and groups by id. */
export function toolContext(
  spec: BotRuntimeSpec,
  store: SessionToolsDeps["store"],
): ToolSessionContext {
  return {
    botId: spec.bot.id,
    conversation: async () => {
      const id = spec.currentConversation?.();
      return id ? store.conversations.get(id) : undefined;
    },
    group: (id) => store.groups.get(id),
  };
}

/** True when the bot names the effects server or one of its tools. */
const wantsEffects = (tools: string[]) =>
  tools.some(
    (t) => t === `mcp__${EFFECTS_MCP_SERVER}` || t.startsWith(`mcp__${EFFECTS_MCP_SERVER}__`),
  );

/**
 * The in-process MCP servers of one session: `memory` for every bot, `effects` only for a bot that names it.
 * Built per session so the tools act for that bot only.
 */
export function sessionTools(deps: SessionToolsDeps) {
  return (spec: BotRuntimeSpec) => {
    const servers: Record<string, ReturnType<typeof memoryServer>> = {
      [MEMORY_MCP_SERVER]: memoryServer(deps.memory, toolContext(spec, deps.store)),
    };
    if (wantsEffects(spec.bot.tools)) {
      const { workspaces } = spec.bot;
      const ctx: EffectsContext = {
        botId: spec.bot.id,
        workspaces,
        home: deps.home,
        // checkInsideWorkspace only asks about paths inside a workspace, so a relative path from one of them is right.
        isSensitive: (real) => workspaces.some((w) => deps.isSensitive(relative(w, real))),
        run: deps.run ?? runCommand,
      };
      servers[EFFECTS_MCP_SERVER] = effectsServer(ctx, deps.projectsDir());
    }
    return servers;
  };
}
