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
import type { ApprovalGateway } from "../src/approvals/approval-types";
import { loadConfig } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { ensureHome } from "../src/memory/persona";
import { openDb } from "../src/storage/db";
import { GLOB_TOOL_NAME, GREP_TOOL_NAME, READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";

/** Discord channel id mapped to the default test workspace `main` (and carried by every test InboundMessage). */
export const TEST_CHANNEL = "100000000000000001";

/** Create a fresh temp AGENT_HOME, real config and real SQLite db. */
export function makeEnv(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "friday-test-"));
  assertTempHome(home);
  const config = loadConfig({
    AGENT_HOME: home,
    TIMEOUT_MS: "5000",
    ...extra,
  });
  // One workspace by default: `location`, a fake git dir OUTSIDE AGENT_HOME (the registry refuses a location inside
  // it; not a managed clone, so Q&A tests never touch the git MCP server). Code-task tests replace it via addLocation().
  const location = join(mkdtempSync(join(tmpdir(), "friday-test-loc-")), "location");
  mkdirSync(join(location, ".git"), { recursive: true });
  addLocation(home, "location", {}, { path: location });
  const db = openDb(workspacePaths(home).dbFile);
  return { home, location, config, db, paths: workspacePaths(home) };
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

/**
 * Text of the first user message of a query's `prompt`: the string itself (qa), or the first item of the
 * streaming input (streaming roles, see run-input-channel.ts). Reads one item; the rest is left unread.
 */
export async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const first = await (prompt as AsyncIterable<{ message: { content: string } }>)
    [Symbol.asyncIterator]()
    .next();
  return first.value?.message.content ?? "";
}

/** A fresh temp dir OUTSIDE any AGENT_HOME (locations inside the home are refused by the registry). */
export const outsideDir = (): string => mkdtempSync(join(tmpdir(), "friday-out-"));

/** Fail unless `home` is under the OS temp dir: tests must never touch the real ~/.friday. */
export function assertTempHome(home: string): void {
  const root = realpathSync(tmpdir());
  const real = realpathSync(home);
  if (!real.startsWith(`${root}${sep}`)) throw new Error(`AGENT_HOME ${home} is not under ${root}`);
}

/** Default path of a test location without an explicit `path`: `workspaces/<ws>/locations/<name>/location`. */
export const defaultLocationPath = (home: string, name: string, workspace = "main"): string =>
  join(workspacePaths(home).workspace(workspace).location(name).root, "location");

/**
 * Register a location in `workspaces/<ws>/workspace.yaml` (`locations:` list; the file is created when missing,
 * or its channels replaced when `channels` is given; `main` defaults to TEST_CHANNEL). Without `path` a dir with
 * a fake git dir is made at `defaultLocationPath` (`git: false` leaves it out). Returns the location path.
 * Only `config.description` is stored: the other keys of old tests (gitAuthor, testCommand...) are ignored.
 */
export function addLocation(
  home: string,
  name: string,
  config: Record<string, string> = {},
  opts: { workspace?: string; channels?: string[]; path?: string; git?: boolean } = {},
): string {
  assertTempHome(home);
  const { workspace = "main", channels, path, git = true } = opts;
  const ws = workspacePaths(home).workspace(workspace);
  mkdirSync(ws.location(name).root, { recursive: true }); // the memory dir of the location
  const doc: { channels?: string[]; locations?: unknown[] } = existsSync(ws.config)
    ? (Bun.YAML.parse(readFileSync(ws.config, "utf8")) ?? {})
    : {};
  if (channels || !existsSync(ws.config)) {
    // `main` is the default test workspace and owns TEST_CHANNEL; any other workspace needs its own channels.
    doc.channels = channels ?? (workspace === "main" ? [TEST_CHANNEL] : []);
  }
  const location = path ?? defaultLocationPath(home, name, workspace);
  mkdirSync(location, { recursive: true });
  if (!path && git) mkdirSync(join(location, ".git"), { recursive: true });
  doc.locations = [
    ...(doc.locations ?? []).filter((l) => (l as { name: string }).name !== name),
    { name, path: location, description: config.description ?? "" },
  ];
  writeFileSync(ws.config, Bun.YAML.stringify(doc));
  return location;
}

/** Remove every workspace config (tests of the "nothing registered" paths). */
export function clearWorkspaces(home: string): void {
  rmSync(workspacePaths(home).workspaces, { recursive: true, force: true });
}

/** Approval gateway that approves everything; override the methods a test cares about. */
export const stubGateway = (over: Partial<ApprovalGateway> = {}): ApprovalGateway => ({
  request: async () => ({ approved: true }),
  confirm: async () => ({ approved: true }),
  cancelTurn: () => {},
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

/** A valid brief of a dev task (the owner's message, tagged so L3 routes it to the dev role). */
export const BRIEF =
  "Add b.txt containing two. Findings: a.txt:1 holds one. Acceptance: file exists.";

/** `BRIEF` as the owner would type it to open a dev task. */
export const DEV_REQUEST = `[dev] ${BRIEF}`;

/** Channel mapped to `w2` (w1 owns TEST_CHANNEL). */
export const CHANNEL_2 = "200000000000000002";

/** Two workspaces `w1` and `w2`, each with a location named `api` (different clones). */
export function twoWorkspaces() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const a = addLocation(
    env.home,
    "api",
    { description: "one" },
    { workspace: "w1", channels: [TEST_CHANNEL] },
  );
  const b = addLocation(
    env.home,
    "api",
    { description: "two" },
    { workspace: "w2", channels: [CHANNEL_2] },
  );
  const scan = loadWorkspaces(env.home);
  ensureHome(env.home, scan.workspaces);
  return { env, a, b, scan };
}
