import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIntentUserPrompt, routingMessageText } from "../src/intent/intent-prompt";
import { parseJevAnswers } from "../src/intent/jev/jev-answer-schema";
import { buildJevQuestions } from "../src/intent/jev/jev-questions";
import { buildJevState } from "../src/intent/jev/jev-state";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";

const SECRET = "API_KEY=supersecretvalue1234567890";
const roles = Object.values(ROLES);
const BG = roles.find((r) => r.background)!;
const FG = roles.find((r) => !r.background)!;

test("state: redacted + clipped message, thread facts, last 4 redacted recent; no pendingQuestion", () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    from: "owner" as const,
    text: `m${i} ${SECRET} ${"x".repeat(400)}`,
  }));
  const s = buildJevState({
    text: `fix it ${SECRET} ${"y".repeat(5000)}`,
    threadId: "th",
    state: "done",
    task: { taskId: "k", ownerRole: BG.name, status: "waiting_user", scope: `scope ${SECRET}` },
    lastRole: FG.name,
    recent,
  });
  const json = JSON.stringify(s);
  expect(json).not.toContain("supersecretvalue");
  expect(s.message.length).toBeLessThanOrEqual(2000);
  expect(s.thread).toEqual({
    state: "done",
    task: { owner: BG.name, scope: expect.stringContaining("scope") },
    lastRole: FG.name,
  });
  expect(s.recent).toHaveLength(4);
  expect(s.recent.every((m) => m.text.length <= 300)).toBe(true);
  expect(json).not.toContain("pendingQuestion");
  expect(buildJevState({ text: "hi", threadId: "th", recent: [] }).thread).toEqual({
    state: "idle",
  });
});

test("questions: role + multi_intent always; continues_task only with a task; fits_last_role only for a side-effect role", () => {
  const base = buildJevQuestions(roles, { hasTask: false });
  expect(Object.keys(base)).toEqual(["role", "multi_intent"]);
  expect(Object.keys(base.role!.criteria!)).toEqual(
    expect.arrayContaining([...roles.filter((r) => r.whenToUse).map((r) => r.name), "unclear"]),
  );
  expect(Object.keys(buildJevQuestions(roles, { hasTask: true }))).toContain("continues_task");
  const noSide = { ...FG, sideEffects: "none" } as RoleDefinition;
  expect(
    buildJevQuestions(roles, { hasTask: false, lastRole: noSide }).fits_last_role,
  ).toBeUndefined();
  const withSide = { ...BG, sideEffects: "location" } as RoleDefinition;
  const q = buildJevQuestions(roles, { hasTask: false, lastRole: withSide }).fits_last_role!;
  expect(q.type).toBe("noul");
  expect(q.instructions).toContain(BG.name);
  for (const c of Object.values(base.role!.criteria!))
    expect((c ?? "").length).toBeLessThanOrEqual(255);
});

test("answer schema: valid, unknown option, out-of-range, missing question", () => {
  const opts = new Set(["a", "unclear"]);
  const ok = {
    role: { choice: "a", probabilities: { a: 0.9, unclear: 0.1 }, confidence: 0.8 },
    multi_intent: { noul: 0.1 },
  };
  expect(parseJevAnswers(ok, opts)).toBeDefined();
  expect(parseJevAnswers({ ...ok, role: { ...ok.role, choice: "zz" } }, opts)).toBeUndefined();
  expect(parseJevAnswers({ ...ok, multi_intent: { noul: 1.5 } }, opts)).toBeUndefined();
  expect(parseJevAnswers({ role: ok.role }, opts)).toBeUndefined();
  expect(parseJevAnswers(null, opts)).toBeUndefined();
});

test("shared redaction: the Haiku user prompt and routingMessageText mask a secret in the message", () => {
  expect(routingMessageText(`deploy ${SECRET}`)).not.toContain("supersecretvalue");
  const prompt = buildIntentUserPrompt({
    text: `deploy ${SECRET}`,
    thread: { state: "idle" },
    ledger: [],
    recent: [],
    roles: [],
  });
  expect(prompt).not.toContain("supersecretvalue");
});

test("no role literal in src/intent/jev (roles are data)", () => {
  const dir = join(import.meta.dir, "../src/intent/jev");
  const src = readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  for (const r of roles) expect(src).not.toMatch(new RegExp(`["'\`]${r.name}["'\`]`));
});
