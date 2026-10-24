import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { BotRuntimeSpec, Store } from "@friday/core";
import {
  CHAT_MCP_SERVER,
  type ChatContext,
  chatServer,
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

/** Env names a git or gh command of an effect tool keeps: the owner's git / gh / ssh auth, nothing of the app. */
const COMMAND_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/** The env of an effect tool's command: only `COMMAND_ENV` names (no Discord or Claude token reaches git or gh). */
export function commandEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of COMMAND_ENV) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * The owner's commit identity as env (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`): git runs without the owner's global config,
 * so a merge commit needs it from here. Empty when the env already names an author. `read(key)` returns a global
 * git config value.
 */
export function ownerIdentityEnv(
  read: (key: string) => string | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (env.GIT_AUTHOR_NAME && env.GIT_AUTHOR_EMAIL) return {};
  const name = read("user.name");
  const email = read("user.email");
  if (!name || !email) return {};
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** One value of the owner's global git config (one line, else undefined). */
function readGlobalGit(key: string): string | undefined {
  const r = Bun.spawnSync(["git", "config", "--global", "--get", key], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const v = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  return v === "" || v.includes("\n") ? undefined : v;
}

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
  /** Source env; commands get only `commandEnv` of it. */
  env?: Record<string, string | undefined>;
  /** Sends a file to a conversation under a bot's name (the surface). */
  postFile: ChatContext["postFile"];
  /** Runs a command (argv, no shell); tests replace it. */
  run?: EffectsContext["run"];
}

/** Run argv in `cwd` with only `env` and a timeout; stdout and stderr are returned together. */
export async function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
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

/**
 * The `isSensitive(real)` of a bot's effect tools: the path relative to the workspace it is in, with each workspace
 * resolved to its real path first (a real target under a symlinked or `/var` workspace still gets the right rel).
 */
export function sensitiveCheck(workspaces: string[], isSensitive: (rel: string) => boolean) {
  const roots = workspaces.map((w) => {
    try {
      return realpathSync.native(w);
    } catch {
      return w;
    }
  });
  return (real: string) =>
    roots.some((r) => {
      const rel = relative(r, real);
      return !rel.startsWith("..") && isSensitive(rel);
    });
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
  const env = { ...commandEnv(deps.env ?? {}), ...ownerIdentityEnv(readGlobalGit, deps.env ?? {}) };
  const run =
    deps.run ??
    ((cmd: string[], cwd: string, extra?: Record<string, string>) =>
      runCommand(cmd, cwd, { ...env, ...extra }));
  return (spec: BotRuntimeSpec) => {
    const servers: Record<string, ReturnType<typeof memoryServer>> = {
      [MEMORY_MCP_SERVER]: memoryServer(deps.memory, toolContext(spec, deps.store)),
    };
    const { workspaces } = spec.bot;
    // Every bot may send a file from its workspaces or its scratch dir (`<home>/scratch/<botId>`, as in `main.ts`).
    servers[CHAT_MCP_SERVER] = chatServer({
      botId: spec.bot.id,
      workspaces,
      scratchDir: join(deps.home, "scratch", spec.bot.id),
      agentHome: deps.home,
      isSensitive: sensitiveCheck(workspaces, deps.isSensitive),
      conversation: () => spec.currentConversation?.(),
      postFile: deps.postFile,
    });
    if (wantsEffects(spec.bot.tools)) {
      const ctx: EffectsContext = {
        botId: spec.bot.id,
        workspaces,
        home: deps.home,
        isSensitive: sensitiveCheck(workspaces, deps.isSensitive),
        run,
      };
      servers[EFFECTS_MCP_SERVER] = effectsServer(ctx, deps.projectsDir(), spec.bot.tools);
    }
    return servers;
  };
}
