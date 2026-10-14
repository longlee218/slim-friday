import { expect, test } from "bun:test";
import { renderUserNotice } from "../src/ingress/user-copy";
import { type DecideInput, decideIntent } from "../src/intent/decide-intent";
import { parseIntentText, validateIntent } from "../src/intent/intent-schema";
import type { IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { actionFor } from "../src/orchestrator/thread/intent-table";
import { STEER_REACT_REPLY } from "../src/orchestrator/thread/steer-notice-sentinel";
import {
  isRepeatedNotice,
  resetNoticeDedupe,
  STEER_DEDUPE_MS,
  steerReply,
} from "../src/orchestrator/thread/steer-reply";
import type { ThreadState } from "../src/orchestrator/thread/thread-state";
import { entryRole, ROLES } from "../src/roles/role-registry";

const base = { role: "dev", scope: "active", confidence: "high", reason: "r" };

test("schema: question true is kept, false / null / missing is dropped", () => {
  expect(parseIntentText(JSON.stringify({ ...base, question: true })).question).toBe(true);
  for (const q of [false, null, undefined])
    expect("question" in parseIntentText(JSON.stringify({ ...base, question: q }))).toBe(false);
});

test("validateIntent passes question through", () => {
  const raw = parseIntentText(JSON.stringify({ ...base, question: true }));
  const v = validateIntent(raw, { hasTask: true });
  expect(v.ok && v.result.question).toBe(true);
});

const pipeline = { lexicon: loadLexicon(), tagRouter: createRoleTagRouter(Object.values(ROLES)) };
const decide = (result: IntentResult) => {
  const i: DecideInput = {
    text: "đang làm tới đâu rồi",
    state: "running",
    hasTask: true,
    scopeFromModel: true,
    l3Input: () => ({
      text: "x",
      thread: { state: "running" },
      ledger: [],
      recent: [],
      roles: [],
    }),
  };
  return decideIntent(i, { pipeline, classifier: { classify: async () => result } });
};

test("decideWithModel: question true lands on the role decision, absent stays unset", async () => {
  const q = await decide({ ...base, question: true } as IntentResult);
  expect(q.decision).toMatchObject({ kind: "role", question: true });
  const n = await decide(base as IntentResult);
  expect(n.decision).not.toHaveProperty("question");
});

test("actionFor: a question is answered by the entry role in every non-idle state, any named role", () => {
  const entry = entryRole().name;
  for (const state of ["running", "awaiting_owner", "awaiting_confirmation"] as ThreadState[])
    for (const r of Object.keys(ROLES))
      for (const scope of ["active", "new"] as const)
        expect(
          actionFor({ decision: { kind: "role", role: r, scope, question: true }, state }),
        ).toEqual({ kind: "side", role: entry });
  // idle: the entry role runs a question; without question the named role runs / opens
  for (const state of ["idle", "done"] as ThreadState[])
    for (const r of Object.keys(ROLES))
      expect(
        actionFor({ decision: { kind: "role", role: r, scope: "new", question: true }, state }),
      ).toEqual({ kind: "run", role: entry });
});

test("copy: plain steer notices, never claim applied", () => {
  expect(renderUserNotice({ kind: "steer", state: "queued" }, "vi")).toBe(
    "Đã nhận, mình chuyển ý này cho việc đang làm.",
  );
  expect(renderUserNotice({ kind: "steer", state: "queued" }, "en")).toBe(
    "Got it, I passed this to the work in progress.",
  );
  for (const state of ["held", "waiting", "full", "ended"] as const)
    expect(renderUserNotice({ kind: "steer", state }, "en")).toMatch(/not applied|not passed/i);
});

test("dedupe: same thread + state inside the window is repeated; a new state or a later time is not", () => {
  resetNoticeDedupe();
  expect(isRepeatedNotice("t1", "queued", 1000)).toBe(false);
  expect(isRepeatedNotice("t1", "queued", 1000 + STEER_DEDUPE_MS - 1)).toBe(true);
  expect(isRepeatedNotice("t1", "held", 2000)).toBe(false);
  expect(isRepeatedNotice("t2", "held", 2000)).toBe(false);
  expect(isRepeatedNotice("t2", "held", 2000 + STEER_DEDUPE_MS)).toBe(false);
});

test("steerReply: the second identical notice in 60 s is the react sentinel", () => {
  resetNoticeDedupe();
  const deps = { steer: { steer: () => ({ result: "held" }) }, db: {} } as never;
  const msg = { threadId: "th-dedupe", language: "en" } as never;
  const first = steerReply(deps, msg, "hi", () => 5000);
  expect(first).not.toBe(STEER_REACT_REPLY);
  expect(steerReply(deps, msg, "hi", () => 6000)).toBe(STEER_REACT_REPLY);
  expect(steerReply(deps, msg, "hi", () => 5000 + STEER_DEDUPE_MS)).not.toBe(STEER_REACT_REPLY);
});

test("steerReply: full and ended notices are never deduped", () => {
  for (const result of ["full", "ended"]) {
    resetNoticeDedupe();
    const deps = { steer: { steer: () => ({ result }) }, db: {} } as never;
    const msg = { threadId: `th-${result}`, language: "en" } as never;
    expect(steerReply(deps, msg, "hi", () => 5000)).not.toBe(STEER_REACT_REPLY);
    expect(steerReply(deps, msg, "hi", () => 6000)).not.toBe(STEER_REACT_REPLY);
  }
});

test("idle table: a question runs the entry role, even when the engine names a background role", () => {
  const d = { kind: "role", role: "dev", scope: "active", question: true } as never;
  expect(actionFor({ decision: d, state: "idle" as ThreadState })).toEqual({
    kind: "run",
    role: entryRole().name,
  });
});
