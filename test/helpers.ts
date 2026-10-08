import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApprovalGateway } from "../src/approvals/approval-types";
import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { TASKS_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { openDb } from "../src/storage/db";
import { DELEGATE_TASK_TOOL_NAME } from "../src/tools/DelegateTaskTool/constants";
import { GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME } from "../src/tools/sdk-tool-names";

/** Create a fresh temp AGENT_HOME, real config and real SQLite db. */
export function makeEnv(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  assertTempHome(home);
  const config = loadConfig({
    AGENT_HOME: home,
    TIMEOUT_MS: "5000",
    ...extra,
  });
  // One workspace by default: `repo`, a fake git dir OUTSIDE workspaces/ (not a managed clone, so Q&A tests
  // never touch the git MCP server). Code-task tests replace it with a managed clone via addRepo().
  const repo = join(home, "plain", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  addRepo(home, "repo", {}, { path: repo });
  const db = openDb(workspacePaths(home).dbFile);
  return { home, repo, config, db, paths: workspacePaths(home) };
}

/** Real `result` message shape captured by spike q06/q08b (keys trimmed to what exists live). */
export function resultMsg(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "alpha is in a.txt:1",
    session_id: "sess-1",
    total_cost_usd: 0.0012,
    num_turns: 2,
    duration_ms: 1500,
    duration_api_ms: 1200,
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    ...over,
  } as unknown as SDKMessage;
}

/** Real `system/init` shape (subset). */
export const initMsg = {
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  cwd: "/x",
  tools: [GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME],
  mcp_servers: [],
  model: "claude-haiku-4-5-20251001",
} as unknown as SDKMessage;

/** Build an injectable query that yields messages, then optionally throws. */
export function fakeQuery(msgs: SDKMessage[], thenThrow?: Error) {
  return (_a: unknown) =>
    (async function* () {
      for (const m of msgs) yield m;
      if (thenThrow) throw thenThrow;
    })();
}

/** Fail unless `home` is under the OS temp dir: tests must never touch the real ~/.friday. */
export function assertTempHome(home: string): void {
  const root = realpathSync(tmpdir());
  const real = realpathSync(home);
  if (!real.startsWith(`${root}${sep}`)) throw new Error(`AGENT_HOME ${home} is not under ${root}`);
}

/**
 * Create `workspaces/<ws>/repos/<name>/repo.yaml` (+ a fake git clone at `.../repo` unless `path` is given),
 * and `workspaces/<ws>/workspace.yaml` when missing (or when `channels` is given). Returns the repo path.
 * `config` holds extra repo.yaml keys (gitAuthor, githubAccount, testCommand...); `workspace` defaults to "main".
 */
export function addRepo(
  home: string,
  name: string,
  config: Record<string, string> = {},
  opts: { workspace?: string; channels?: string[]; path?: string } = {},
): string {
  assertTempHome(home);
  const { workspace = "main", channels, path } = opts;
  const ws = workspacePaths(home).workspace(workspace);
  const rp = ws.repo(name);
  mkdirSync(rp.root, { recursive: true });
  if (channels || !existsSync(ws.config)) {
    const list = (channels ?? []).map((c) => `  - "${c}"`).join("\n");
    writeFileSync(ws.config, channels?.length ? `channels:\n${list}\n` : "channels: []\n");
  }
  const repo = path ?? rp.clone;
  if (!path) mkdirSync(join(repo, ".git"), { recursive: true });
  const lines = [
    `path: ${repo}`,
    ...Object.entries(config).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
  ];
  writeFileSync(rp.config, `${lines.join("\n")}\n`);
  return repo;
}

/** Remove every workspace config (tests of the "nothing registered" paths). */
export function clearWorkspaces(home: string): void {
  rmSync(workspacePaths(home).workspaces, { recursive: true, force: true });
}

/** Approval gateway that approves everything; override the methods a test cares about. */
export const stubGateway = (over: Partial<ApprovalGateway> = {}): ApprovalGateway => ({
  request: async () => ({ approved: true }),
  requestPlan: async () => ({ approved: true }),
  confirm: async () => ({ approved: true }),
  cancelTask: () => {},
  askChoice: async () => undefined,
  ...over,
});

/** Rolled files of a pino-roll base path (`<base>.<date>.<n>.jsonl`), full paths. */
export function rolledFiles(base: string): string[] {
  const name = basename(base);
  return readdirSync(dirname(base))
    .filter((f) => f.startsWith(`${name}.`) && f.endsWith(".jsonl"))
    .map((f) => join(dirname(base), f));
}

/** Parsed JSON lines of all rolled files of a base path ([] when none). */
export function readLogLines(base: string): Record<string, unknown>[] {
  try {
    return rolledFiles(base).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
  } catch {
    return [];
  }
}

/**
 * Talk to an in-process MCP server of the SDK options the way the SDK would: a real MCP client over an
 * in-memory transport linked to `options.mcpServers[name].instance`. `call` runs one tool.
 */
export async function connectAppTool(options: any, name = TASKS_MCP_SERVER) {
  const server = options.mcpServers[name].instance;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    call: (tool: string, args: Record<string, unknown>) =>
      client.callTool({ name: tool, arguments: args }) as Promise<{
        isError?: boolean;
        content: { type: string; text: string }[];
      }>,
    close: () => client.close(),
  };
}

/**
 * Fake SDK for handoff tests: a run that has the `tasks` server is the Q&A run; it calls `DelegateTask` once
 * per entry of `calls`, then ends with a result. Every other run (plan / exec stage) goes to `next`.
 * `results` collects what each `DelegateTask` call returned.
 */
export function delegatingQuery(
  calls: Record<string, unknown>[],
  next: (a: any) => AsyncIterable<SDKMessage>,
  results: { isError?: boolean; text: string }[] = [],
) {
  return (a: any) => {
    if (!a.options?.mcpServers?.[TASKS_MCP_SERVER]) return next(a);
    return (async function* () {
      const tool = await connectAppTool(a.options);
      try {
        for (const c of calls) {
          const r = await tool.call(DELEGATE_TASK_TOOL_NAME, { role: "dev", ...c });
          results.push({ isError: r.isError, text: r.content[0]?.text ?? "" });
        }
      } finally {
        await tool.close();
      }
      yield resultMsg({ result: "I will hand this over.", session_id: "sess-qa" });
    })();
  };
}

/** A valid brief for the `DelegateTask` tool (min 20 chars). */
export const BRIEF =
  "Add b.txt containing two. Findings: a.txt:1 holds one. Acceptance: file exists.";
