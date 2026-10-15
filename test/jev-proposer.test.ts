import { expect, test } from "bun:test";
import { loadConfig } from "../src/config/agent-config";
import { type JevClient, JevError, type JevRaw } from "../src/intent/jev/jev-client";
import { createJevProposer } from "../src/intent/jev/jev-proposer";
import { DEV_ROLE } from "../src/roles/builtin/dev-role";
import { LEAD_ROLE } from "../src/roles/builtin/lead-role";
import type { RoleDefinition } from "../src/roles/role-types";

/** Two roles the proposer picks between (the registry no longer has a plain foreground specialist): a foreground and a background one. */
const FG = "fg-probe";
const BG = "bg-probe";
const ROLES_UNDER_TEST: RoleDefinition[] = [
  { ...LEAD_ROLE, name: FG, whenToUse: "answers questions", surface: undefined },
  { ...DEV_ROLE, name: BG },
];

const SECRET = "API_KEY=supersecretvalue1234567890";
const usage = { input_tokens: 10, output_tokens: 2 };

/** Fake Jev client: records every request, answers with `answers` (or throws). */
function fakeClient(reply: JevRaw["answers"] | Error) {
  const calls: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const client: JevClient = {
    ask: async (state, questions) => {
      calls.push({ state, questions });
      if (reply instanceof Error) throw reply;
      return { answers: reply, usage };
    },
  };
  return { client, calls };
}
const answers = (probs: Record<string, number>, extra: Record<string, unknown> = {}) => {
  const [choice] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
  return {
    role: { type: "choice", choice, probabilities: probs, confidence: 0.9 },
    multi_intent: { type: "noul", noul: 0.05 },
    ...extra,
  };
};
const decisive = () => answers({ [FG]: 0.9, [BG]: 0.05, unclear: 0.05 });
const base = { text: "what is alpha", threadId: "th", recent: [] };
test("proposer: decisive answer -> pick, numbers + ms in scores, state carries no secret", async () => {
  const f = fakeClient(decisive());
  const p = await createJevProposer(f.client, () => ROLES_UNDER_TEST).propose({
    ...base,
    text: `x ${SECRET}`,
  });
  expect(p).toMatchObject({ kind: "pick", role: FG });
  expect(p.scores).toMatchObject({ top: 0.9, band: "pick", ms: expect.any(Number) });
  expect(JSON.stringify(f.calls)).not.toContain("supersecretvalue");
  expect(Object.keys(f.calls[0]!.questions)).toEqual(["role", "multi_intent"]);
});

test("proposer: error matrix -> undecided with a reason, never throws", async () => {
  const cases: [Error | JevRaw["answers"], string][] = [
    [new JevError("timeout", "t"), "timeout"],
    [new JevError("error", "401"), "error"],
    [new Error("429 rate limited"), "error"],
    [new DOMException("aborted", "AbortError"), "error"],
    [{ role: "garbage" }, "invalid_answer"],
    [answers({ ghost: 1 }), "invalid_answer"],
  ];
  for (const [reply, reason] of cases) {
    const p = await createJevProposer(fakeClient(reply).client, () => ROLES_UNDER_TEST).propose(
      base,
    );
    expect(p).toMatchObject({ kind: "undecided", reason });
  }
});

test("config: JEV_API_KEY real vs missing / placeholder / sk_ stub", () => {
  const c = (JEV_API_KEY?: string) =>
    loadConfig({ AGENT_HOME: "/tmp/x", ...(JEV_API_KEY !== undefined && { JEV_API_KEY }) }).intent
      .jevApiKey;
  expect(c("abc123")).toBe("abc123");
  for (const v of [undefined, "", "REPLACE_ME", "sk_"]) expect(c(v)).toBeUndefined();
});
