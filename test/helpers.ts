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
import type { IntentDeps } from "../src/intent/decide-intent";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { ensureHome } from "../src/memory/persona";
import { ROLES } from "../src/roles/role-registry";
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

/** Fail unless `home` is under the OS temp dir: tests must never touch the real ~/.friday. */
export function assertTempHome(home: string): void {
  const root = realpathSync(tmpdir());
  const real = realpathSync(home);
  if (!real.startsWith(`${root}${sep}`)) throw new Error(`AGENT_HOME ${home} is not under ${root}`);
}

/**
 * Create `workspaces/<ws>/repos/<name>/repo.yaml` (+ a fake git clone at `.../repo` unless `path` is given),
 * and `workspaces/<ws>/workspace.yaml` when missing (or when `channels` is given; `main` defaults to TEST_CHANNEL). Returns the repo path.
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
    // `main` is the default test workspace and owns TEST_CHANNEL; any other workspace needs its own channels.
    const ids = channels ?? (workspace === "main" ? [TEST_CHANNEL] : []);
    const list = ids.map((c) => `  - "${c}"`).join("\n");
    writeFileSync(ws.config, ids.length ? `channels:\n${list}\n` : "channels: []\n");
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

/** Intent layer with L0-L3 only (no L4 engine): a `[dev]` message opens a dev task straight through the dispatcher. */
export const devIntent = (home: string): IntentDeps => ({
  pipeline: { lexicon: loadLexicon(home), tagRouter: createRoleTagRouter(Object.values(ROLES)) },
});

/** A valid brief of a dev task (the owner's message, tagged so L3 routes it to the dev role). */
export const BRIEF =
  "Add b.txt containing two. Findings: a.txt:1 holds one. Acceptance: file exists.";

/** `BRIEF` as the owner would type it to open a dev task. */
export const DEV_REQUEST = `[dev] ${BRIEF}`;

/** Channel mapped to `w2` (w1 owns TEST_CHANNEL). */
export const CHANNEL_2 = "200000000000000002";

/** Two workspaces `w1` and `w2`, each with a repo named `api` (different clones). */
export function twoWorkspaces() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const a = addRepo(
    env.home,
    "api",
    { description: "one" },
    { workspace: "w1", channels: [TEST_CHANNEL] },
  );
  const b = addRepo(
    env.home,
    "api",
    { description: "two" },
    { workspace: "w2", channels: [CHANNEL_2] },
  );
  const scan = loadWorkspaces(env.home);
  ensureHome(env.home, scan.workspaces);
  return { env, a, b, scan };
}

/**
 * Test stand-in for the L3 model's reading of a yes / no: when a question is pending, a whole message that
 * agrees or declines gets `pendingAnswer`; everything else is `base` unchanged. (A fake of the LLM, not product
 * logic: the product never matches words.)
 */
export const answering =
  <T extends { pendingQuestion?: string; text: string }, R extends object>(base: R) =>
  (i: T): R & { pendingAnswer?: "yes" | "no" } => {
    const t = i.text.trim().toLowerCase();
    const pendingAnswer = !i.pendingQuestion
      ? undefined
      : /^(yes|ok|okay|đồng ý)$/.test(t)
        ? "yes"
        : /^(no|khong|không|thôi)$/.test(t)
          ? "no"
          : undefined;
    return { ...base, ...(pendingAnswer && { pendingAnswer }) };
  };
