import { join } from "node:path";
import type { EngineDeps } from "@friday/api";
import { expandServer, type FileConfig } from "@friday/config";
import type { McpProbe } from "@friday/core";
import { createMcpProbe } from "@friday/runtime-claude";
import {
  createConfigAdmin,
  createMemoryAdmin,
  createSkillAdmin,
  type FileMemory,
} from "@friday/tools";
import { ownerDesignContext } from "./design-context";
import { commandEnv, runCommand } from "./session-tools";

/** What `createSettings` is made from. */
export interface SettingsDeps {
  /** The live config (the admins write files; the watcher reloads this). */
  config: FileConfig;
  agentHome: string;
  /** The app's own memory instance: its `onChange` (index rebuild, provider write-through) must still fire. */
  memory: FileMemory;
  /** Memory prompt cap shown in the UI (`memoryPromptChars`). */
  capChars: number;
  /** The engine's env: the values of a server's `${NAME}` references come from here, nothing else of it leaves. */
  env: Record<string, string | undefined>;
  /** `PATH` handed to git and to a probed server. */
  pathEnv: string;
  /** The SDK `query` of the probe (tests pass a fake). */
  probeQuery?: NonNullable<Parameters<typeof createMcpProbe>[0]["query"]>;
}

/**
 * The connection test of an MCP server: `${NAME}` references are filled from `env` first (a missing one answers
 * `needs <NAMES>` and starts nothing). The SDK process gets only `PATH` and `HOME`: the server's values are already
 * in its spec, so the engine's tokens and keys never reach the process of a server under test.
 */
function mcpProbeOf(d: SettingsDeps): McpProbe {
  const probeEnv: Record<string, string> = { PATH: d.pathEnv };
  if (d.env.HOME) probeEnv.HOME = d.env.HOME;
  const probe = createMcpProbe({ env: probeEnv, ...(d.probeQuery && { query: d.probeQuery }) });
  return async (name, server) => {
    const r = expandServer(server, d.env);
    if ("missing" in r) return { status: "failed", error: `needs ${r.missing.join(", ")}` };
    return probe(name, r.server);
  };
}

/**
 * The settings admins behind the web API, over the live config and the app's own memory. Config and skill writes go
 * to `<AGENT_HOME>/config/` and the watcher reloads them; skill lookups wait in `<AGENT_HOME>/data/skill-lookups`
 * (inside the agent home, which every bot run denies).
 */
export function createSettings(d: SettingsDeps): EngineDeps["settings"] {
  const env = commandEnv(d.env);
  const ctx = {
    ...ownerDesignContext({ config: d.config, agentHome: d.agentHome }, (cmd, cwd, extra) =>
      runCommand(cmd, cwd, { ...env, ...extra }),
    ),
    // The owner's admins read no engine log and no messages; the bots' memory dirs are the real ones.
    memory: d.memory,
    insight: { runStats: async () => [], turns: async () => [], activity: async () => [] },
    messages: { get: async () => undefined, page: async () => [] },
  };
  return {
    config: createConfigAdmin(ctx),
    skills: createSkillAdmin({
      ctx,
      lookupDir: join(d.agentHome, "data", "skill-lookups"),
      pathEnv: d.pathEnv,
      now: () => Date.now(),
    }),
    memory: createMemoryAdmin({
      memory: d.memory,
      root: join(d.agentHome, "memory"),
      capChars: d.capChars,
    }),
    probe: mcpProbeOf(d),
  };
}
