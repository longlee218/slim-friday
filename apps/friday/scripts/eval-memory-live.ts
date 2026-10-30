/**
 * Owner-run live check (spends real model calls; never part of `bun test`):
 *   bun run eval:memory --live [--cap-usd 0.5]
 * Case `memory-after-resume`: a session opened with memory "codeword AMBER" is resumed with memory "codeword COBALT"
 * through `openRunSession`; the bot must answer COBALT (the fresh memory), not AMBER (the first system prompt).
 * Writes `<AGENT_HOME>/logs/eval-memory-<stamp>.json` and prints one line per case. Without `--live` it only prints usage.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRuntime,
  type Bot,
  type BotSession,
  CORE_DEFAULTS,
  type InboundTurn,
  type Memory,
  openRunSession,
  type Store,
} from "@friday/core";
import { ClaudeRuntime } from "@friday/runtime-claude";
import { HAIKU_MODEL } from "../src/config/model-ids";

interface CaseResult {
  case: string;
  passed: boolean;
  costUsd: number;
  detail: string;
}

const USAGE = "Usage: bun run eval:memory --live [--cap-usd 0.5]  (spends real model calls)";
const QUESTION = "Reply with the codeword only.";
const TURN_TIMEOUT_MS = 120_000;
const out = (s: string) => process.stdout.write(`${s}\n`);

const args = process.argv.slice(2);
if (!args.includes("--live")) {
  out(USAGE);
  process.exit(0);
}
const capIdx = args.indexOf("--cap-usd");
const capUsd = capIdx >= 0 ? Number(args[capIdx + 1]) : 0.5;
if (!(capUsd > 0)) {
  out(`--cap-usd must be a positive number. ${USAGE}`);
  process.exit(1);
}
const logHome = process.env.AGENT_HOME;
if (!logHome) {
  out("AGENT_HOME is not set: the result file goes to <AGENT_HOME>/logs.");
  process.exit(1);
}

/** The memory dependency: a fixed text for the bot. */
const memoryWith = (codeword: string): Memory => ({
  read: async () => `- (fact) The test codeword is ${codeword}.`,
  save: async () => {},
  edit: async () => {},
});

/** The few store parts `openRunSession` reads, held in memory (one stored session id). */
function fakeStore(): Store {
  const sessions = new Map<string, string>();
  return {
    sessions: {
      get: async (k: string) => sessions.get(k),
      set: async (k: string, id: string) => void sessions.set(k, id),
      clear: async (k: string) => void sessions.delete(k),
    },
    scopes: { get: async () => undefined },
    cards: { openForScope: async () => [] },
    groups: { get: async () => undefined },
    bots: { list: async () => [] },
    scratchpad: { list: async () => [] },
  } as unknown as Store;
}

const bot: Bot = {
  id: "eval-memory",
  name: "Eval",
  title: "Memory check",
  instructions: "You answer in as few words as possible.",
  model: HAIKU_MODEL,
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
};

/** Send the question, read the reply until the turn ends; the cost of the turn is added to `spent`. */
async function ask(session: BotSession, spent: { usd: number }): Promise<string> {
  const turn: InboundTurn = {
    conversationId: "eval-conversation",
    from: { kind: "user" },
    text: QUESTION,
    hop: 0,
    context: [],
    now: Date.now(),
    timeZone: "UTC",
  };
  session.send(turn);
  let reply = "";
  const read = (async () => {
    for await (const ev of session.events) {
      if (ev.type === "text") reply += ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
      else if (ev.type === "turn_end") {
        spent.usd += ev.costUsd;
        return;
      }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("turn timed out")), TURN_TIMEOUT_MS);
  });
  try {
    await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
    await session.stop();
  }
  return reply;
}

/** Open (or resume, when the store holds an id) the scope's session with `codeword` in memory. */
const openWith = (runtime: AgentRuntime, store: Store, codeword: string) =>
  openRunSession(
    { runtime, store, memory: memoryWith(codeword), limits: CORE_DEFAULTS },
    { key: bot.id, bot },
    {
      bot,
      runKind: "owner",
      sessionKey: bot.id,
      decide: async () => ({ behavior: "deny", reason: "eval" }),
    },
  );

/** First session says AMBER, the resumed one must say COBALT. */
async function memoryAfterResume(
  runtime: AgentRuntime,
  spent: { usd: number },
): Promise<CaseResult> {
  const store = fakeStore();
  const first = await ask((await openWith(runtime, store, "AMBER")).session, spent);
  if (spent.usd > capUsd)
    return {
      case: "memory-after-resume",
      passed: false,
      costUsd: spent.usd,
      detail: `cap ${capUsd} USD passed`,
    };
  const resumed = await openWith(runtime, store, "COBALT");
  const second = await ask(resumed.session, spent);
  const passed = second.includes("COBALT");
  return {
    case: "memory-after-resume",
    passed,
    costUsd: spent.usd,
    detail: `first reply: ${first.trim()} | resumed reply: ${second.trim()}`,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "friday-eval-memory-"));
const runtime = new ClaudeRuntime({
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  agentHome: join(tmp, "home"),
  scratchRoot: join(tmp, "scratch"),
  env: process.env,
});
const spent = { usd: 0 };
const results: CaseResult[] = [];
try {
  results.push(await memoryAfterResume(runtime, spent));
} catch (err) {
  results.push({
    case: "memory-after-resume",
    passed: false,
    costUsd: spent.usd,
    detail: err instanceof Error ? err.message : String(err),
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const logs = join(logHome, "logs");
mkdirSync(logs, { recursive: true });
const file = join(logs, `eval-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
for (const r of results)
  out(`${r.passed ? "PASS" : "FAIL"} ${r.case} ($${r.costUsd.toFixed(4)}) ${r.detail}`);
out(`Result: ${file}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
