/**
 * Shared parts of the owner-run live memory check (`eval-memory-live.ts`): an in-memory store, the eval bot, a
 * session opener and one question turn. Never part of `bun test`; it only runs when the owner runs the script.
 */
import {
  type AgentRuntime,
  type Bot,
  type BotSession,
  CORE_DEFAULTS,
  type InboundTurn,
  type Memory,
  openRunSession,
  type SessionStateHashes,
  type Store,
} from "@friday/core";
import { HAIKU_MODEL } from "../src/config/model-ids";

/** One case's line in the result file; an `informational` case reports what it saw and never fails the run. */
export interface CaseResult {
  case: string;
  passed: boolean;
  informational?: boolean;
  costUsd: number;
  detail: string;
  /** For `prompt-vs-transcript`: the codeword the resumed reply named ("COBALT", "AMBER" or "neither"). */
  said?: string;
}

/** The question that asks for the codeword. */
export const QUESTION = "Reply with the codeword only.";
const TURN_TIMEOUT_MS = 120_000;

/** The memory dependency: a fixed text for the bot. */
const memoryWith = (codeword: string): Memory => ({
  read: async () => `- (fact) The test codeword is ${codeword}.`,
  save: async () => {},
  edit: async () => {},
});

/** The few store parts `openRunSession` reads, held in memory (one stored session id and its state hashes). */
export function fakeStore(): Store {
  const sessions = new Map<string, string>();
  const hashes = new Map<string, SessionStateHashes>();
  return {
    sessions: {
      get: async (k: string) => sessions.get(k),
      set: async (k: string, id: string) => {
        if (sessions.get(k) !== id) hashes.delete(k);
        sessions.set(k, id);
      },
      stateGet: async (k: string) => hashes.get(k),
      stateSet: async (k: string, h: SessionStateHashes) => {
        if (sessions.has(k)) hashes.set(k, h);
      },
      clear: async (k: string) => {
        sessions.delete(k);
        hashes.delete(k);
      },
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

/**
 * Send `text` (with the session's `<state_changed>` block when given, as a run's turn carries it), read the reply
 * until the turn ends; the cost of the turn is added to `spent`.
 */
export async function ask(
  session: BotSession,
  spent: { usd: number },
  text: string,
  stateChanged?: string,
): Promise<string> {
  const turn: InboundTurn = {
    conversationId: "eval-conversation",
    from: { kind: "user" },
    text,
    hop: 0,
    context: [],
    ...(stateChanged && { stateChanged }),
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
export const openWith = (runtime: AgentRuntime, store: Store, codeword: string) =>
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
