import { pickEnv } from "../config/agent-config";

/** The one git backend of the agent's read tools: @cyanheads/git-mcp-server, pinned in package.json (no npx, no network at runtime). */
const entry = (): string => Bun.resolveSync("@cyanheads/git-mcp-server", import.meta.dir);

/**
 * Env of one server process: stdio transport, no signing, no terminal prompts. It carries no commit identity (it
 * serves reads only; the developer agent commits through its own shell with the owner's git config).
 */
export function gitServerEnv(): Record<string, string> {
  return {
    ...pickEnv(["PATH", "HOME", "USER", "SSH_AUTH_SOCK"]),
    MCP_TRANSPORT_TYPE: "stdio",
    MCP_LOG_LEVEL: "error",
    GIT_SIGN_COMMITS: "false",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** `mcpServers` entry for the SDK (the agent's own server process, one per run). */
export function gitMcpServerConfig() {
  return { command: process.execPath, args: [entry()], env: gitServerEnv() };
}
