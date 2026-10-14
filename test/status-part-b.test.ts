import { expect, test } from "bun:test";
import { STEER_READ_EMOJI } from "../src/ingress/message-reaction";
import { type DecideInput, decideIntent } from "../src/intent/decide-intent";
import type { IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import { actionFor } from "../src/orchestrator/thread/intent-table";
import { routeByIntent } from "../src/orchestrator/thread/route-by-intent";
import { STEER_REACT_REPLY } from "../src/orchestrator/thread/steer-notice-sentinel";
import { resetNoticeDedupe } from "../src/orchestrator/thread/steer-reply";
import {
  clearProgressNote,
  getProgressNote,
  PROGRESS_NOTE_MAX,
  setProgressNote,
} from "../src/orchestrator/turns/progress-notes";
import { statusFacts, statusSnapshot } from "../src/orchestrator/turns/status-snapshot";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import { entryRole, ROLES } from "../src/roles/role-registry";
import type { SteerSink } from "../src/runtime/run-input-channel";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertToolCall } from "../src/storage/run-metrics-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";

type Db = ReturnType<typeof makeEnv>["db"];

/** A running dev turn with `n` Bash calls (description `d<i>`), then a Grep call whose input holds a secret. */
function runningTurn(db: Db, calls: { tool: string; input: unknown }[], id = "t1") {
  insertTurn(db, { id, threadId: "th", source: "t", location: "r", role: "dev", brief: "x" });
  for (const [i, c] of calls.entries())
    insertToolCall(db, {
      id: `${id}-c${i}`,
      runId: "run1",
      turnId: id,
      tool: c.tool,
      inputJson: JSON.stringify(c.input),
      outputPreview: "",
      isError: false,
      durationMs: 1,
    });
}

// ---- step 5: snapshot -------------------------------------------------------------------------------

test("progress notes: redacted, clipped, cleared at run end", () => {
  setProgressNote("pn", `working on it sk-ant-api03-SECRETSECRETSECRET ${"x".repeat(400)}`);
  const note = getProgressNote("pn") as string;
  expect(note).not.toContain("SECRETSECRET");
  expect(note.length).toBeLessThanOrEqual(PROGRESS_NOTE_MAX);
  clearProgressNote("pn");
  expect(getProgressNote("pn")).toBeUndefined();
});

test("snapshot: tool count, last 5 tools (Bash description only, redacted, 80 chars), progress note; no raw input", () => {
  const env = makeEnv();
  const calls = [
    ...Array.from({ length: 4 }, (_, i) => ({
      tool: "Bash",
      input: { command: `rm -rf /secret/path-${i}`, description: `delete dir ${i}` },
    })),
    {
      tool: "Bash",
      input: {
        command: "echo",
        description: `leak sk-ant-api03-SECRETSECRETSECRET ${"d".repeat(200)}`,
      },
    },
    { tool: "Grep", input: { pattern: "TOPSECRET-PATTERN", path: "/home/x" } },
  ];
  runningTurn(env.db, calls);
  setProgressNote("t1", "Deleted 3 folders so far");
  const snap = statusSnapshot(env.db, "th");
  clearProgressNote("t1");
  expect(snap).toContain("tools so far: 6");
  expect(snap.match(/^- recent: /gm)).toHaveLength(5); // the oldest of the 6 is not listed
  expect(snap).not.toContain("delete dir 0");
  expect(snap).toContain("recent: Bash: delete dir 1");
  expect(snap).toContain("recent: Grep"); // name only
  expect(snap).toContain("latest progress note: Deleted 3 folders so far");
  expect(snap).not.toContain("SECRETSECRET");
  expect(snap).not.toContain("rm -rf");
  expect(snap).not.toContain("TOPSECRET-PATTERN");
  expect(snap).not.toContain("/home/x");
  const longLine = snap.split("\n").find((l) => l.includes("leak")) as string;
  expect(longLine.replace("- recent: Bash: ", "").length).toBeLessThanOrEqual(80);
});

test("statusFacts: nothing running and no owned task -> undefined; snapshot -> empty string", () => {
  const env = makeEnv();
  expect(statusFacts(env.db, "th")).toBeUndefined();
  expect(statusSnapshot(env.db, "th")).toBe("");
});

// ---- step 6: busy fallback --------------------------------------------------------------------------

const pipeline = { lexicon: loadLexicon(), tagRouter: createRoleTagRouter(Object.values(ROLES)) };
const decide = (classify: () => Promise<IntentResult>) => {
  const i: DecideInput = {
    text: "hmm",
    state: "running",
    hasTask: true,
    scopeFromModel: true,
    l3Input: () => ({ text: "x", thread: { state: "running" }, ledger: [], recent: [], roles: [] }),
  };
  return decideIntent(i, { pipeline, classifier: { classify } });
};
const ok = { role: "dev", scope: "active", confidence: "high", reason: "r" } as IntentResult;

test("fallback supplements are unclear: L3 throw, invalid answer, low confidence; a clear active is not", async () => {
  expect(
    (
      await decide(async () => {
        throw new Error("down");
      })
    ).decision,
  ).toMatchObject({ unclear: true });
  expect((await decide(async () => ({ ...ok, role: "no-such-role" }))).decision).toMatchObject({
    unclear: true,
  });
  expect((await decide(async () => ({ ...ok, confidence: "low" }))).decision).toMatchObject({
    unclear: true,
  });
  expect((await decide(async () => ok)).decision).not.toHaveProperty("unclear");
});

test("actionFor: unclear while working steers (any role, even a side role); clear active keeps its row", () => {
  const entry = entryRole().name;
  expect(
    actionFor({
      decision: { kind: "role", role: entry, scope: "active", unclear: true },
      state: "running",
    }),
  ).toEqual({ kind: "steer", role: entry, unclear: true });
  expect(
    actionFor({ decision: { kind: "role", role: "dev", scope: "active" }, state: "running" }),
  ).toEqual({ kind: "steer", role: "dev" });
});

/** Minimal route context over a fake steer registry that records what it was given. */
function routeCtx(db: Db) {
  const steered: string[] = [];
  const message = {
    source: "t",
    language: "en" as const,
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th",
    text: "how far?",
  };
  const deps = {
    db,
    steer: {
      steer: (_m: unknown, t: string) => (steered.push(t), { result: "queued" as const }),
      record() {},
    },
  };
  const ctx = {
    deps,
    message,
    workspace: "w",
    locations: [],
    ac: new AbortController(),
    busy: true,
    text: message.text,
  };
  return { ctx: ctx as never, steered };
}

test("unclear steer: the message is steered AND a side answer is requested, steer line leads (one reply)", async () => {
  resetNoticeDedupe();
  const env = makeEnv();
  const { ctx, steered } = routeCtx(env.db);
  const out = await routeByIntent(ctx, { kind: "steer", role: entryRole().name, unclear: true });
  expect(steered).toEqual(["how far?"]);
  expect(out).toMatchObject({ kind: "side", role: entryRole().name, text: "how far?" });
  expect((out as { lead?: string }).lead).toContain("Got it");
  // a repeated notice inside the window: no lead line, the answer alone
  const again = await routeByIntent(ctx, { kind: "steer", role: entryRole().name, unclear: true });
  expect(again).toMatchObject({ kind: "side" });
  expect((again as { lead?: string }).lead).toBeUndefined();
  expect(steered).toHaveLength(2);
});

test("clear active steer: steer only, no side answer", async () => {
  resetNoticeDedupe();
  const env = makeEnv();
  const { ctx, steered } = routeCtx(env.db);
  const out = await routeByIntent(ctx, { kind: "steer", role: "dev" });
  expect(steered).toEqual(["how far?"]);
  expect(out).toMatchObject({ kind: "reply" });
  expect((out as { text: string }).text).not.toBe(STEER_REACT_REPLY);
});

// ---- step 7: /status --------------------------------------------------------------------------------

const statusHandler = (db: Db, env: ReturnType<typeof makeEnv>) => {
  let calls = 0;
  const handle = createTurnHandler({
    db,
    config: env.config,
    queryFn: (() => {
      calls++;
      throw new Error("model must not be called");
    }) as never,
  });
  const say = (text: string) =>
    handle({
      source: "t",
      language: "en",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "th",
      text,
    });
  return { say, calls: () => calls };
};

test("/status parses to the status command; with an argument it is a plain message", () => {
  expect(parseMessageCommand("/status")).toEqual({ kind: "status" });
  expect(parseMessageCommand("/status foo")).toMatchObject({
    kind: "message",
    text: "/status foo",
  });
});

test("/status: nothing running -> one line; no model call", async () => {
  const env = makeEnv();
  const h = statusHandler(env.db, env);
  expect(await h.say("/status")).toBe("Nothing is running.");
  expect(h.calls()).toBe(0);
});

test("/status: a running task shows role, tools and the progress note (redacted); no model call", async () => {
  const env = makeEnv();
  runningTurn(env.db, [{ tool: "Bash", input: { command: "ls", description: "list files" } }]);
  setProgressNote("t1", "Almost done sk-ant-api03-SECRETSECRETSECRET");
  const h = statusHandler(env.db, env);
  const text = (await h.say("/status")) as string;
  clearProgressNote("t1");
  expect(text).toContain("Running (dev");
  expect(text).toContain("1 tools so far");
  expect(text).toContain("- Bash: list files");
  expect(text).toContain("Latest note: Almost done");
  expect(text).not.toContain("SECRETSECRET");
  expect(h.calls()).toBe(0);
});

test("/status: no running task but a waiting owned task -> its last state", async () => {
  const env = makeEnv();
  runningTurn(env.db, [{ tool: "Edit", input: { file_path: "/x" } }]);
  finishTurn(env.db, "t1", "interrupted");
  insertOwnedTask(env.db, {
    id: "ot1",
    threadId: "th",
    ownerRole: "dev",
    status: "waiting_user",
    scope: "clean the logs folder",
    correlationId: "c1",
  });
  linkTurn(env.db, "t1", "ot1");
  const h = statusHandler(env.db, env);
  const text = (await h.say("/status")) as string;
  expect(text).toContain("Waiting task (dev, waiting_user), stopped");
  expect(text).toContain("Scope: clean the logs folder");
  expect(text).toContain("- Edit");
  expect(text).not.toContain("/x");
  expect(h.calls()).toBe(0);
});

// ---- step 7b: delivered receipt ---------------------------------------------------------------------

/** Registry with a fake reaction port and a sink that remembers the row ref of each push. */
function receiptEnv(failReact = false) {
  const env = makeEnv();
  insertTurn(env.db, {
    id: "t1",
    threadId: "th",
    source: "t",
    location: "r",
    role: "dev",
    brief: "x",
  });
  const reacted: [string, string, string][] = [];
  const reg = createSteerRegistry(env.db, {
    react: async (thread, message, emoji) => {
      reacted.push([thread, message, emoji]);
      if (failReact) throw new Error("no permission");
      return true;
    },
  });
  const refs: { ref?: string; text: string }[] = [];
  const sink: SteerSink = { push: (text, ref) => (refs.push({ ref, text }), "queued") };
  const hook = reg.hook("th");
  hook.register(sink, { runId: "r1", turnId: "t1" });
  const events: unknown[] = [];
  reg.subscribe("th", "t1", (e) => events.push(e));
  return { reg, hook, refs, reacted, events };
}

test("delivered steer: 👀 on the owner's own message id; the event carries it", async () => {
  const r = receiptEnv();
  r.reg.steer({ threadId: "th", messageId: "m-owner-1" }, "first");
  r.reg.steer({ threadId: "th", messageId: "m-owner-2" }, "second");
  r.hook.settle(r.refs[1] as never, "delivered"); // only the second was read
  await Promise.resolve();
  expect(r.reacted).toEqual([["th", "m-owner-2", STEER_READ_EMOJI]]);
  expect(r.events).toContainEqual({ state: "delivered", messageId: "m-owner-2" });
});

test("unread steer: no 👀, dropped notice unchanged", async () => {
  const r = receiptEnv();
  r.reg.steer({ threadId: "th", messageId: "m-owner-1" }, "never read");
  r.hook.settle(r.refs[0] as never, "dropped");
  await Promise.resolve();
  expect(r.reacted).toEqual([]);
  expect(r.reg.undeliveredNotice("th")).toContain("never read");
});

test("a failing reaction never throws into the run", async () => {
  const r = receiptEnv(true);
  r.reg.steer({ threadId: "th", messageId: "m1" }, "x");
  expect(() => r.hook.settle(r.refs[0] as never, "delivered")).not.toThrow();
  await Promise.resolve();
  expect(r.reacted).toHaveLength(1);
});
