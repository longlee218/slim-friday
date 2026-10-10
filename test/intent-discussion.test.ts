import { expect, test } from "bun:test";
import { createAliasRouter } from "../src/intent/alias-router";
import { decideIntent } from "../src/intent/decide-intent";
import { buildIntentInput } from "../src/intent/intent-input";
import { buildIntentSystemPrompt, buildIntentUserPrompt } from "../src/intent/intent-prompt";
import type { IntentClassifier, IntentInput, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { actionFor } from "../src/orchestrator/thread/route-by-intent";
import { intentRoles, ROLES } from "../src/roles/role-registry";
import { insertTask } from "../src/storage/run-store";
import { upsertStage } from "../src/storage/stage-store";
import { makeEnv } from "./helpers";
import { scoreClass } from "./intent-eval-score";

const router = createAliasRouter(Object.values(ROLES));
const route = (t: string) => router.route(t, true);
const roleOf = (t: string) => {
  const d = route(t);
  return d.decided ? d.role : `undecided:${d.roles.join("+")}`;
};

test("explicit 'do not code' statements route to the assistant at L3 (accented or not)", () => {
  for (const t of [
    "Tôi không yêu cầu bạn code, chúng ta đang thảo luận",
    "đừng code gì cả",
    "không cần code, chỉ cần ý kiến",
    "just discuss it with me",
    "please do not code yet",
  ])
    expect(roleOf(t)).toBe("assistant");
});

test("generic discussion words are NOT aliases: a code request containing them is never captured at L3", () => {
  for (const t of [
    "Thêm API trao đổi dữ liệu",
    "Thiết kế lại kiến trúc thông báo để hỗ trợ nhiều kênh, trao đổi qua queue",
    "Add a discuss endpoint to the forum API",
    "thảo luận về lớp cache",
    "Let's discuss the Response Layer",
    "bàn về cách chia module",
  ])
    expect(roleOf(t)).toBe("undecided:"); // no role at L3: L4 (conversation rule + lastTurn) decides
});

test("negated 'do not code' does not count; with a strong dev phrase two roles match = undecided (L4)", () => {
  expect(roleOf("không cần code nữa, code đi")).toBe("undecided:assistant+dev");
  expect(roleOf("đừng đừng code")).toBe("undecided:"); // negator right before the phrase
  expect(roleOf("Không đừng code")).toBe("undecided:");
});

test("L4 prompt: discussion rule, previous turn fact; message part still capped at 2000", () => {
  expect(buildIntentSystemPrompt(intentRoles())).toContain("Conversation rule, ONLY when");
  const up = buildIntentUserPrompt({
    text: "x".repeat(9000),
    thread: { state: "idle", lastTurn: { role: "assistant", kind: "qa" } },
    ledger: [],
    roles: [],
  });
  expect(up).toContain("previous turn: assistant/qa");
  expect(up.split("<<<MESSAGE\n")[1]!.split("\nMESSAGE>>>")[0]!.length).toBe(2000);
});

test("buildIntentInput: lastTurn = role and last stage of the thread's latest task; none for a new thread", () => {
  const env = makeEnv();
  expect(
    buildIntentInput(env.db, { threadId: "th", text: "x", state: "idle" }).thread.lastTurn,
  ).toBeUndefined();
  insertTask(env.db, { id: "t1", threadId: "th", source: "t", repo: "r", role: "assistant" });
  upsertStage(env.db, { taskId: "t1", idx: 0, name: "qa", status: "done" });
  const t = buildIntentInput(env.db, { threadId: "th", text: "x", state: "idle" }).thread;
  expect(t.lastTurn).toEqual({ role: "assistant", kind: "qa" });
});

/** decideIntent with a fake L4 answering `res`, for an idle thread whose previous turn was `lastRole`. */
async function decide(text: string, res: Partial<IntentResult>, lastRole?: string, state = "idle") {
  const env = makeEnv();
  const classifier: IntentClassifier = {
    classify: async () => ({ role: "dev", scope: "new", confidence: "high", reason: "r", ...res }),
  };
  const l4Input = (): IntentInput => ({
    text,
    thread: {
      state: state as never,
      ...(lastRole && { lastTurn: { role: lastRole, kind: "qa" } }),
    },
    ledger: [],
    roles: intentRoles(),
  });
  const { decision } = await decideIntent(
    { text, state: state as never, hasTask: false, l4Input },
    { pipeline: { lexicon: loadLexicon(env.home), aliasRouter: router }, classifier },
  );
  return decision;
}

test("guard: L4 alone, dev/new, previous turn answered -> confirmDev; otherwise a plain role decision", async () => {
  const q = "Tôi đề xuất xây dựng một lớp cache, bạn thấy sao?";
  expect(await decide(q, {}, "assistant")).toMatchObject({
    role: "dev",
    scope: "new",
    confirmDev: true,
  });
  expect(await decide(q, {}, undefined)).not.toHaveProperty("confirmDev"); // first turn of the thread
  expect(await decide(q, {}, "dev")).not.toHaveProperty("confirmDev"); // previous turn was a task
  expect(await decide(q, { role: "assistant" }, "assistant")).not.toHaveProperty("confirmDev");
  // L3 decides (strong alias / tag): no L4, no guard
  expect(await decide("[dev] thêm cache", {}, "assistant")).not.toHaveProperty("confirmDev");
  expect(await decide("code đi", {}, "assistant")).not.toHaveProperty("confirmDev");
});

test("table: confirmDev on an idle thread -> confirm-dev action; without it -> open", () => {
  const base = { state: "idle" as const, hasClone: false, fixRounds: 0 };
  const d = { kind: "role" as const, role: "dev", scope: "new" as const };
  expect(actionFor({ ...base, decision: { ...d, confirmDev: true } })).toEqual({
    kind: "confirm-dev",
    role: "dev",
  });
  expect(actionFor({ ...base, decision: d })).toEqual({ kind: "open", role: "dev" });
});

test("eval scoring: a missing class counts as standard for dev (effective), raw stays a miss", () => {
  const role = (o: object) => ({ kind: "role", role: "dev", scope: "new", ...o }) as never;
  expect(scoreClass(role({}), "standard")).toEqual({ raw: false, effective: true });
  expect(scoreClass(role({}), "design")).toEqual({ raw: false, effective: false });
  expect(scoreClass(role({ cls: "design" }), "design")).toEqual({ raw: true, effective: true });
  expect(scoreClass({ kind: "ask", reason: "low_confidence" }, "standard")).toEqual({
    raw: false,
    effective: false,
  });
  expect(scoreClass(role({ role: "assistant" }), "standard").effective).toBe(false);
});
