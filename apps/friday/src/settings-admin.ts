import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EngineDeps } from "@friday/api";
import { expandServer, type FileConfig, isOAuthServer } from "@friday/config";
import type { McpProbe, ModelCatalog } from "@friday/core";
import { createMcpProbe, createModelCatalog } from "@friday/runtime-claude";
import {
  createConfigAdmin,
  createMemoryAdmin,
  createSkillAdmin,
  type FileMemory,
} from "@friday/tools";
import { ownerDesignContext } from "./design-context";
import type { McpProxy } from "./mcp-oauth/mcp-proxy";
import { createPermissionsAdmin } from "./permissions-admin";
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
  /** The local OAuth proxy: an OAuth server is probed through it (its tokens never reach the probe). */
  mcpProxy?: Pick<McpProxy, "configFor">;
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
  const root = join(d.agentHome, "data", "mcp-probe");
  return async (name, server) => {
    // An OAuth server is reached only through the proxy, which adds the bearer token of the saved login.
    const target = isOAuthServer(server) && d.mcpProxy ? d.mcpProxy.configFor(name) : server;
    const r = expandServer(target, d.env);
    if ("missing" in r) return { status: "failed", error: `needs ${r.missing.join(", ")}` };
    // A fresh empty dir (0700) per probe, removed afterwards: the server never starts in the engine's cwd, where a
    // `.env` could be read, and one probe leaves nothing for the next.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const cwd = mkdtempSync(join(root, "p-"));
    try {
      const probe = createMcpProbe({
        env: probeEnv,
        cwd,
        ...(d.probeQuery && { query: d.probeQuery }),
      });
      return await probe(name, r.server);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

/** How long a model list is kept before the SDK is asked again. */
const MODELS_TTL_MS = 10 * 60_000;

/**
 * The model list, kept for ten minutes (a failed ask is not kept). The SDK process gets only `PATH` and `HOME`, as the
 * probe does, and starts in an empty dir.
 */
function modelCatalogOf(d: SettingsDeps): ModelCatalog {
  const env: Record<string, string> = { PATH: d.pathEnv };
  if (d.env.HOME) env.HOME = d.env.HOME;
  // The OAuth token is the SDK's only login; without it the list would be empty.
  if (d.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = d.env.CLAUDE_CODE_OAUTH_TOKEN;
  const root = join(d.agentHome, "data", "model-list");
  let kept: { at: number; list: Awaited<ReturnType<ModelCatalog>> } | undefined;
  return async () => {
    if (kept && Date.now() - kept.at < MODELS_TTL_MS) return kept.list;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const cwd = mkdtempSync(join(root, "m-"));
    try {
      const list = await createModelCatalog({
        env,
        cwd,
        ...(d.probeQuery && { query: d.probeQuery }),
      })();
      kept = { at: Date.now(), list };
      return list;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
    permissions: createPermissionsAdmin(d.config, d.agentHome),
    models: modelCatalogOf(d),
  };
}
