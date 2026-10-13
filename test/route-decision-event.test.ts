import { expect, test } from "bun:test";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentClassifier, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { captureLogs } from "../src/observability/logger";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn, setTurnSession } from "../src/storage/run-store";
import { initMsg, makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const msg = (text: string, threadId: string) => ({
  source: "t",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId,
  text,
  messageId: `m-${threadId}`,
});
const verdict = (o: Partial<IntentResult> = {}): IntentResult => ({
  role: "assistant",
  scope: "new",
  confidence: "high",
  reason: "SECRET-REASON",
  ...o,
});
const queryFn = (() =>
  (async function* () {
    yield initMsg;
    yield resultMsg({ result: "answer" });
  })()) as never;

/** Handle `text` once; return the route.decision lines and all lines of the message. */
async function route(text: string, result?: IntentResult, withIntent = true) {
  const env = makeEnv();
  const classifier: IntentClassifier = { classify: async () => result ?? verdict() };
  const intent: IntentDeps = {
    pipeline: {
      lexicon: loadLexicon(env.home),
      tagRouter: createRoleTagRouter(Object.values(ROLES)),
    },
    classifier,
  };
  const cap = captureLogs();
  await createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn,
    ...(withIntent && { intent }),
  })(msg(text, "th1"));
  cap.stop();
  return { decisions: cap.lines.filter((l) => l.event === "route.decision"), all: cap.lines };
}

test("tag: one route.decision, source tag, EXPLICIT_TAG, same traceId on every line", async () => {
  const { decisions, all } = await route("[ask] what is alpha");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    source: "tag",
    rationaleCode: "EXPLICIT_TAG",
    candidateAgentId: "assistant",
    conversationId: "th1",
    messageId: "m-th1",
  });
  const trace = decisions[0].traceId as string;
  expect(typeof trace).toBe("string");
  expect(all.filter((l) => l.traceId !== trace).map((l) => l.event)).toEqual([]);
  expect(all.some((l) => l.event === "span" && l.span === "classify")).toBe(true);
  expect(all.some((l) => l.event === "span" && l.span === "execute")).toBe(true);
});

test("L3 pick: source fallback, MODEL_FALLBACK", async () => {
  const { decisions } = await route("what does alpha do");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ source: "fallback", rationaleCode: "MODEL_FALLBACK" });
});

test("unknown role from L3: ask -> source clarify, AMBIGUOUS_INTENT", async () => {
  const { decisions } = await route("do something", verdict({ role: "nonexistent" }));
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ source: "clarify", rationaleCode: "AMBIGUOUS_INTENT" });
});

test("intent off: source fallback, ENTRY_DEFAULT", async () => {
  const { decisions } = await route("hello there", undefined, false);
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    source: "fallback",
    rationaleCode: "ENTRY_DEFAULT",
    candidateAgentId: "assistant",
  });
});

test("route.decision and span lines carry metadata only (field whitelist, no text)", async () => {
  const { decisions, all } = await route("[ask] my private question", verdict());
  const allowed = new Set([
    "level",
    "time",
    "pid",
    "hostname",
    "module",
    "event",
    "msg",
    "traceId",
    "threadId",
    "channelId",
    "taskId",
    "workspace",
    "repo",
    "mode",
    "messageId",
    "conversationId",
    "ownedTaskId",
    "source",
    "candidateAgentId",
    "alternatives",
    "rationaleCode",
    "ambiguityFlags",
    "routingVersion",
    "timestamp",
    // Recovery metadata (role names / flags only)
    "initialCandidate",
    "rerouted",
    "visited",
    "preflight",
  ]);
  for (const l of decisions) expect(Object.keys(l).filter((k) => !allowed.has(k))).toEqual([]);
  for (const l of all.filter((l) => l.event === "span"))
    expect(
      Object.keys(l).filter((k) => !["span", "durationMs", "ok"].includes(k) && !allowed.has(k)),
    ).toEqual([]);
  expect(JSON.stringify([...decisions, ...all.filter((l) => l.event === "span")])).not.toContain(
    "private",
  );
});

test("resume (`go +<usd>` on a budget-stopped task): one route.decision, source owner, RESUME, the resumed role", async () => {
  const env = makeEnv();
  // A budget-stopped assistant task in thread t1 (same fixture as proposal-flow: session + failed run).
  insertTurn(env.db, { id: "tb", threadId: "t1", source: "s", repo: "repo", role: "assistant" });
  setTurnSession(env.db, "tb", "sess-b", env.repo);
  insertRun(env.db, {
    id: "rb",
    turnId: "tb",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1,
    turns: 1,
    durationMs: 1,
    outcome: "max_budget",
    compactions: 0,
  });
  env.db.query("UPDATE turns SET status = 'failed' WHERE id = 'tb'").run();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: (() =>
      (async function* () {
        yield initMsg;
        yield resultMsg({ result: "resumed" });
      })()) as never,
  });
  const cap = captureLogs();
  await handle({ ...msg("go +2", "t1"), messageId: "m-go" });
  cap.stop();
  const decisions = cap.lines.filter((l) => l.event === "route.decision");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    source: "owner",
    rationaleCode: "RESUME",
    candidateAgentId: "assistant",
    conversationId: "t1",
    messageId: "m-go",
  });
});
