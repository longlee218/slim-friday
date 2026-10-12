import { describe, expect, test } from "bun:test";
import { captureLogs } from "../src/observability/logger";
import { emptyUsage } from "../src/observability/record-run";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import {
  avgContextTokens,
  compactIdleSession,
  FRESH_SESSION_CONTEXT_TOKENS,
} from "../src/orchestrator/turns/session-compaction";
import { LEDGER_HEADING } from "../src/storage/ledger-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { getSession, setSession } from "../src/storage/session-store";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const big = { ...emptyUsage(), turns: 2, cacheReadTokens: FRESH_SESSION_CONTEXT_TOKENS * 2 };
const small = { ...emptyUsage(), turns: 2, cacheReadTokens: 1000 };

/** A task of `role` in thread th with a stored session. */
function setup(role: string) {
  const env = makeEnv();
  insertTurn(env.db, { id: "t1", threadId: "th", source: "t", repo: "r", role });
  setSession(env.db, { threadId: "th", sessionId: "s1", repo: "r", cwd: "/x" });
  return env;
}

describe("app-driven session compaction (fresh session + ledger)", () => {
  test("average context per turn from the run usage", () => {
    expect(
      avgContextTokens({ ...emptyUsage(), turns: 4, inputTokens: 40, cacheReadTokens: 360 }),
    ).toBe(100);
    expect(avgContextTokens(emptyUsage())).toBe(0);
  });

  test("over the threshold: the stored session is dropped and the event carries sizes only", () => {
    const env = setup("assistant");
    const cap = captureLogs();
    expect(compactIdleSession(env.db, { turnId: "t1", threadId: "th" }, big)).toBe(true);
    cap.stop();
    expect(getSession(env.db, "th")).toBeNull();
    const ev = cap.lines.find((l) => l.event === "session.compacted")!;
    expect(ev).toMatchObject({ mode: "fresh_ledger", threshold: FRESH_SESSION_CONTEXT_TOKENS });
    expect(Object.keys(ev).some((k) => /^(text|brief|prompt|reply)$/.test(k))).toBe(false);
  });

  test("cost guard: a small session, a role without the ledger, or no usage keeps the session", () => {
    const a = setup("assistant");
    expect(compactIdleSession(a.db, { turnId: "t1", threadId: "th" }, small)).toBe(false);
    expect(compactIdleSession(a.db, { turnId: "t1", threadId: "th" }, undefined)).toBe(false);
    expect(getSession(a.db, "th")).not.toBeNull();
    const d = setup("dev");
    expect(compactIdleSession(d.db, { turnId: "t1", threadId: "th" }, big)).toBe(false);
    expect(getSession(d.db, "th")).not.toBeNull();
  });

  test("end to end: a big finished turn -> the next turn is a FRESH session seeded with the task ledger", async () => {
    const env = makeEnv();
    // An earlier delivered dev task is what the ledger lists.
    insertTurn(env.db, {
      id: "d1",
      threadId: "th1",
      source: "t",
      repo: "r",
      role: "dev",
      brief: "earlier job",
    });
    finishTurn(env.db, "d1", "done");
    const seen: any[] = [];
    const queryFn = (a: any) => {
      seen.push(a.options);
      return (async function* () {
        yield resultMsg({
          session_id: `sess-${seen.length}`,
          num_turns: 1,
          usage: { input_tokens: 100, cache_read_input_tokens: FRESH_SESSION_CONTEXT_TOKENS * 2 },
        });
      })();
    };
    const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: queryFn as never });
    const msg = (text: string) => ({
      source: "t",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "th1",
      text,
    });
    await handle(msg("[ask] first question"));
    expect(getSession(env.db, "th1")).toBeNull(); // dropped: over the threshold
    await handle(msg("[ask] second question"));
    expect(seen[1].resume).toBeUndefined(); // fresh session
    expect(seen[1].systemPrompt.append).toContain(LEDGER_HEADING);
    expect(seen[1].systemPrompt.append).toContain("earlier job");
  });
});
