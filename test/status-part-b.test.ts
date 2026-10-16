import { expect, test } from "bun:test";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { parseMessageCommand } from "../src/orchestrator/message-commands";
import {
  clearProgressNote,
  getProgressNote,
  PROGRESS_NOTE_MAX,
  setProgressNote,
} from "../src/orchestrator/turns/progress-notes";
import { statusFacts } from "../src/orchestrator/turns/status-snapshot";
import { createSteerRegistry } from "../src/orchestrator/turns/steer-registry";
import type { SteerSink } from "../src/runtime/run-input-channel";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertToolCall } from "../src/storage/run-metrics-store";
import { finishTurn, insertTurn } from "../src/storage/run-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";

type Db = ReturnType<typeof makeEnv>["db"];

/** A running dev turn with `n` Bash calls (description `d<i>`), then a Grep call whose input holds a secret. */
function runningTurn(db: Db, calls: { tool: string; input: unknown }[], id = "t1") {
  insertTurn(db, { id, threadId: "th", source: "t", location: "r", role: "developer", brief: "x" });
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
  const f = statusFacts(env.db, "th");
  clearProgressNote("t1");
  expect(f?.running && f.toolCount).toBe(6);
  const recent = f?.running ? f.recent : [];
  expect(recent).toHaveLength(5); // the oldest of the 6 is not listed
  const all = JSON.stringify(f);
  expect(all).not.toContain("delete dir 0");
  expect(recent.map((r) => `${r.tool}: ${r.description ?? ""}`)).toContain("Bash: delete dir 1");
  expect(recent.some((r) => r.tool === "Grep" && !r.description)).toBe(true); // name only
  expect(f?.running && f.note).toBe("Deleted 3 folders so far");
  for (const leak of ["SECRETSECRET", "rm -rf", "TOPSECRET-PATTERN", "/home/x"])
    expect(all).not.toContain(leak);
  const leakLine = recent.find((r) => r.description?.includes("leak"));
  expect(leakLine?.description?.length).toBeLessThanOrEqual(80);
});

test("statusFacts: nothing running and no owned task -> undefined", () => {
  const env = makeEnv();
  expect(statusFacts(env.db, "th")).toBeUndefined();
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
  expect(parseMessageCommand("/status foo")).toEqual({ kind: "message" });
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
    ownerRole: "developer",
    status: "waiting_user",
    scope: "clean the logs folder",
    correlationId: "c1",
  });
  linkTurn(env.db, "t1", "ot1");
  const h = statusHandler(env.db, env);
  const text = (await h.say("/status")) as string;
  expect(text).toContain("Waiting task (developer, waiting_user), stopped");
  expect(text).toContain("Scope: clean the logs folder");
  expect(text).toContain("- Edit");
  expect(text).not.toContain("/x");
  expect(h.calls()).toBe(0);
});

// ---- step 7b: delivered state ----------------------------------------------------------------------

/** Registry with a sink that remembers the row ref of each push, and a subscriber on the run's turn. */
function receiptEnv() {
  const env = makeEnv();
  insertTurn(env.db, {
    id: "t1",
    threadId: "th",
    source: "t",
    location: "r",
    role: "developer",
    brief: "x",
  });
  const reg = createSteerRegistry(env.db);
  const refs: { ref?: string; text: string }[] = [];
  const sink: SteerSink = { push: (text, ref) => (refs.push({ ref, text }), "queued") };
  const hook = reg.hook("th");
  hook.register(sink, { runId: "r1", turnId: "t1" });
  const events: unknown[] = [];
  reg.subscribe("th", "t1", (e) => events.push(e));
  return { reg, hook, refs, events };
}

test("delivered steer: the event carries the owner's own message id", () => {
  const r = receiptEnv();
  r.reg.steerTask("t1", "first", "m-owner-1");
  r.reg.steerTask("t1", "second", "m-owner-2");
  r.hook.settle(r.refs[1] as never, "delivered"); // only the second was read
  expect(r.events).toContainEqual({ state: "delivered", messageId: "m-owner-2" });
  expect(r.events).not.toContainEqual({ state: "delivered", messageId: "m-owner-1" });
});

test("unread steer: a dropped event, never delivered", () => {
  const r = receiptEnv();
  r.reg.steerTask("t1", "never read", "m-owner-1");
  r.hook.settle(r.refs[0] as never, "dropped");
  expect(r.events).toContainEqual({ state: "dropped", messageId: "m-owner-1" });
  expect(r.events.some((e) => (e as { state: string }).state === "delivered")).toBe(false);
});
