import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config/agent-config";
import { openDb } from "../src/storage/db";
import { workspacePaths } from "../src/workspace/workspace-paths";

/** Create a fresh temp AGENT_HOME, real config and real SQLite db. */
export function makeEnv(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  const config = loadConfig({
    AGENT_HOME: home,
    DEFAULT_REPO_PATH: home,
    TIMEOUT_MS: "5000",
    ...extra,
  });
  const db = openDb(workspacePaths(home).dbFile);
  return { home, config, db, paths: workspacePaths(home) };
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
