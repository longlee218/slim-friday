import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { BotMessenger, BotRuntimeSpec, InsightStore, Store, TicketBoard } from "@friday/core";
import { scratchName } from "@friday/runtime-claude";
import {
  CHAT_MCP_SERVER,
  type ChatContext,
  chatServer,
  DESIGN_MCP_SERVER,
  type DesignContext,
  designServer,
  EFFECTS_MCP_SERVER,
  type EffectsContext,
  effectsServer,
  type FileMemory,
  MEMORY_MCP_SERVER,
  type MemoryRecall,
  type MessageSearchDeps,
  memoryServer,
  TICKETS_MCP_SERVER,
  type ToolSessionContext,
  ticketsServer,
} from "@friday/tools";
import { FRIDAY_BOT_ID } from "./friday-bot";

/** Empty review views, for a build without the engine db (tests, tools-only runs). */
const NO_INSIGHT: InsightStore = {
  runStats: async () => [],
  turns: async () => [],
  activity: async () => [],
};

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

/** The env of an effect tool's command: only `COMMAND_ENV` names (no app or Claude token reaches git or gh). */
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
  /** Search over the notes (`MemorySearch`). */
  recall: MemoryRecall;
  /** Search over past messages (`MessageSearch`); without it the tool is not offered. */
  messages?: MessageSearchDeps;
  store: Pick<Store, "conversations" | "groups" | "bots" | "messages">;
  /** The agent home (the trash lives under it). */
  home: string;
  /** Where `CreateProject` makes repos (read per session, so a settings change applies to new sessions). */
  projectsDir: () => string;
  /** True for a sensitive path relative to its workspace (`.env`, keys...). */
  isSensitive: (rel: string) => boolean;
  /** Source env; commands get only `commandEnv` of it. */
  env?: Record<string, string | undefined>;
  /** Reaches the other bots (the hub); a bot in no group (see `groupIdsOf`) is not given it. */
  messenger?: BotMessenger;
  /** The shared ticket board, once the hub exists (read per session: the runtime is built before the hub). */
  tickets?: () => TicketBoard | undefined;
  /** The ids of the groups a bot is in. */
  groupIdsOf?: (botId: string) => string[];
  /** Sends a file to a conversation under a bot's name (the surface). */
  postFile: ChatContext["postFile"];
  /** Runs a command (argv, no shell); tests replace it. */
  run?: EffectsContext["run"];
  /** The design context of a session (for a bot that names the `design` server). */
  design?: (
    spec: BotRuntimeSpec,
    run: EffectsContext["run"],
  ) => Omit<DesignContext, "memory" | "insight" | "messages">;
  /** Review views over the engine's own log, for `BotInsight`; without it the views are empty. */
  insight?: InsightStore;
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

/** A messenger that sends from one session: the hub finds the sender by session key, not by bot id. */
const sessionMessenger = (messenger: BotMessenger, sessionKey: string): BotMessenger => ({
  send: (_from, req) => messenger.send(sessionKey, req),
});

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
    // A group session never reaches the owner's direct chat (MessageSearch).
    ...(spec.groupId
      ? { groupId: spec.groupId }
      : { direct: () => store.conversations.direct(spec.bot.id) }),
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

/** The scratch dir of one session (`<home>/scratch/<scratchName>`, the runtime's own dir for it). */
export const sessionScratchDir = (home: string, spec: BotRuntimeSpec): string =>
  join(home, "scratch", scratchName(spec));

/** True when the bot names a server (all of it) or one of its tools. */
const wantsServer = (tools: string[], server: string) =>
  tools.some((t) => t === `mcp__${server}` || t.startsWith(`mcp__${server}__`));

/**
 * The in-process MCP servers of one session: `memory` and `chat` for every bot, `effects` and `design` only for a bot
 * that names them.
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
      [MEMORY_MCP_SERVER]: memoryServer(
        deps.memory,
        deps.recall,
        toolContext(spec, deps.store),
        deps.messages,
      ),
    };
    const { workspaces } = spec.bot;
    // Every bot may send a file from its workspaces or its session's scratch dir (the runtime's, see `main.ts`).
    servers[CHAT_MCP_SERVER] = chatServer({
      botId: spec.bot.id,
      workspaces,
      scratchDir: sessionScratchDir(deps.home, spec),
      agentHome: deps.home,
      isSensitive: sensitiveCheck(workspaces, deps.isSensitive),
      conversation: () => spec.currentConversation?.(),
      postFile: deps.postFile,
      ...(deps.messenger &&
        (deps.groupIdsOf?.(spec.bot.id).length ?? 0) > 0 && {
          messenger: sessionMessenger(deps.messenger, spec.sessionKey ?? spec.bot.id),
        }),
      // Read when the tool runs: the runtime fills `apply` after the session is built.
      effort: {
        max: spec.bot.maxEffort,
        apply: (level) =>
          spec.effortControl?.apply?.(level) ?? Promise.reject(new Error("no session")),
      },
    });
    if (wantsServer(spec.bot.tools, EFFECTS_MCP_SERVER)) {
      const ctx: EffectsContext = {
        botId: spec.bot.id,
        workspaces,
        home: deps.home,
        isSensitive: sensitiveCheck(workspaces, deps.isSensitive),
        run,
      };
      servers[EFFECTS_MCP_SERVER] = effectsServer(ctx, deps.projectsDir(), spec.bot.tools);
    }
    // The ticket tools: only for a bot that names them, and once the hub (which owns the board) exists.
    const board = deps.tickets?.();
    if (board && wantsServer(spec.bot.tools, TICKETS_MCP_SERVER))
      servers[TICKETS_MCP_SERVER] = ticketsServer(
        {
          botId: spec.bot.id,
          board,
          bots: deps.store.bots,
          conversation: () => spec.currentConversation?.(),
        },
        spec.bot.tools,
      );
    // The design tools are the Friday bot\'s alone, whatever another bot file names.
    if (
      deps.design &&
      spec.bot.id === FRIDAY_BOT_ID &&
      wantsServer(spec.bot.tools, DESIGN_MCP_SERVER)
    )
      servers[DESIGN_MCP_SERVER] = designServer({
        ...deps.design(spec, run),
        memory: deps.memory,
        insight: deps.insight ?? NO_INSIGHT,
        messages: deps.store.messages,
      });
    return servers;
  };
}
