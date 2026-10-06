import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { pickEnv } from "../config/agent-config";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { connectStdio, toolText } from "./mcp-stdio";

/** Commit identity `Name <email>` split into parts. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** Structured result of a git MCP tool call (`structuredContent`). */
// biome-ignore lint/suspicious/noExplicitAny: the server's result shape differs per tool
export type GitData = Record<string, any>;

/** The one git backend: @cyanheads/git-mcp-server, pinned in package.json (no npx, no network at runtime). */
const entry = (): string => Bun.resolveSync("@cyanheads/git-mcp-server", import.meta.dir);

/**
 * Env of one server process. Identity goes in as GIT_AUTHOR_* and GIT_COMMITTER_* so every commit
 * made through it carries the owner (never the machine's global git user). `baseDir` sandboxes all
 * git operations to one directory tree. Signing is off (no GPG prompt); no terminal prompts.
 */
export function gitServerEnv(
  o: { author?: GitIdentity; baseDir?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ...pickEnv(["PATH", "HOME", "USER", "SSH_AUTH_SOCK"]),
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "error",
    GIT_SIGN_COMMITS: "false",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (o.baseDir) env.GIT_BASE_DIR = o.baseDir;
  if (o.author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = o.author.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = o.author.email;
  }
  return env;
}

/** `mcpServers` entry for the SDK (the agent's own server process, one per run). */
export function gitMcpServerConfig(o: { author?: GitIdentity; baseDir?: string } = {}) {
  return { command: process.execPath, args: [entry()], env: gitServerEnv(o) };
}

/** The app's handle on the git MCP server (worktrees, fetch, push, inspection). */
export interface GitMcp {
  /**
   * Call a git MCP tool; throws (token-free message) when the tool reports an error.
   * Every call is logged as `git.call` (tool, ms, ok).
   */
  call(tool: string, args: Record<string, unknown>): Promise<GitData>;
  close(): Promise<void>;
}

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "git-mcp" });

/** Per-call cap so a stalled push/fetch cannot hold a task forever. */
const CALL_TIMEOUT_MS = 60_000;

/** One long-lived server process for the app, started on first use. */
export function createGitMcp(): GitMcp {
  let client: Promise<Client> | undefined;
  const connect = () =>
    connectStdio({ command: process.execPath, args: [entry()], env: gitServerEnv() });
  /** One call without logging. */
  const callTool = async (tool: string, args: Record<string, unknown>): Promise<GitData> => {
    client ??= connect();
    const c = await client.catch((e) => {
      client = undefined; // retry on the next call
      throw e;
    });
    const r = (await c.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as { isError?: boolean; structuredContent?: GitData };
    if (r.isError) throw new Error(errText(`${tool} failed: ${toolText(r)}`));
    return r.structuredContent ?? {};
  };
  return {
    async call(tool, args) {
      const t0 = Date.now();
      try {
        const data = await callTool(tool, args);
        logEvent(log, "git.call", { tool, ms: Date.now() - t0, ok: true });
        return data;
      } catch (err) {
        logEvent(log, "git.call", { tool, ms: Date.now() - t0, ok: false, err: errText(err) });
        throw err;
      }
    },
    async close() {
      const c = await client?.catch(() => undefined);
      client = undefined;
      await c?.close();
    },
  };
}
