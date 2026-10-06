import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalGateway } from "../src/approvals/approval-types";
import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { openDb } from "../src/storage/db";

/** Create a fresh temp AGENT_HOME, real config and real SQLite db. */
export function makeEnv(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  const config = loadConfig({
    AGENT_HOME: home,
    TIMEOUT_MS: "5000",
    ...extra,
  });
  // One workspace by default: `repo`, a fake git dir OUTSIDE workspaces/ (not a managed clone, so Q&A tests
  // never touch the git MCP server). Code-task tests replace it with a managed clone via addWorkspace().
  const repo = join(home, "plain", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  addWorkspace(home, "repo", {}, repo);
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
  tools: ["Glob", "Grep", "Read"],
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

/**
 * Create `workspaces/<name>/config.yaml` (+ a fake git clone at workspaces/<name>/repo unless `path` is given).
 * Returns the repo path. `config` holds extra config.yaml keys (gitAuthor, githubAccount, testCommand...).
 */
export function addWorkspace(
  home: string,
  name: string,
  config: Record<string, string> = {},
  path?: string,
): string {
  const ws = workspacePaths(home).workspace(name);
  mkdirSync(ws.root, { recursive: true });
  const repo = path ?? ws.repo;
  if (!path) mkdirSync(join(repo, ".git"), { recursive: true });
  const lines = [
    `path: ${repo}`,
    ...Object.entries(config).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
  ];
  writeFileSync(ws.config, `${lines.join("\n")}\n`);
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
