import { expect, test } from "bun:test";
import { HAIKU_MODEL } from "../src/config/model-ids";
import { DIGEST_HEADING } from "../src/memory/channel-digest";
import type { RoleRunInput } from "../src/orchestrator/run/role-run-types";
import { runRole } from "../src/orchestrator/run/run-role";
import {
  firstPromptPrefix,
  OWNER_MESSAGE_LABEL,
  withPrefix,
} from "../src/roles/prompts/first-prompt-prefix";
import { ROLES } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { openDb } from "../src/storage/db";
import { insertTurn } from "../src/storage/run-store";
import { saveTitle } from "../src/storage/thread-store";
import { markRolled, saveSummary } from "../src/storage/thread-summary-store";
import { fakeQuery, makeEnv, resultMsg, stubGateway } from "./helpers";

/** A run input with only what the prefix reads. */
const input = (over: Partial<RoleRunInput> = {}): RoleRunInput =>
  ({
    turnId: "cur",
    threadId: "th",
    channelId: "c1",
    recent: [{ from: "owner", text: "q" }],
    ...over,
  }) as RoleRunInput;

/** A db with a rolled thread `th` (summary) and one titled thread in channel c1. */
function seeded() {
  const db = openDb(":memory:");
  saveTitle(db, "other", "Earlier topic", "", 1, "c1", "main");
  saveSummary(db, "th", "main", "SUM");
  markRolled(db, "th");
  return db;
}

test("seed then digest, in that order, in one prefix", () => {
  const p = firstPromptPrefix(seeded(), input(), true);
  expect(p.startsWith("Thread summary so far")).toBe(true);
  expect(p.indexOf("SUM")).toBeLessThan(p.indexOf(DIGEST_HEADING));
  expect(p).toContain("Earlier topic");
});

test("background role (no seed allowed): digest only, no seed", () => {
  const p = firstPromptPrefix(seeded(), input(), false);
  expect(p.startsWith(DIGEST_HEADING)).toBe(true);
  expect(p).not.toContain("SUM");
});

test("channel mode: absent = task (digest), task = digest, chat = none", () => {
  const db = seeded();
  expect(firstPromptPrefix(db, input(), false)).toContain("Earlier topic");
  expect(firstPromptPrefix(db, input({ channelMode: "task" }), false)).toContain("Earlier topic");
  expect(firstPromptPrefix(db, input({ channelMode: "chat" }), false)).toBe("");
});

test("withPrefix labels the owner text after the DATA blocks; no prefix = the text alone", () => {
  expect(withPrefix("DATA", "hi")).toBe(`DATA\n\n${OWNER_MESSAGE_LABEL}\nhi`);
  expect(withPrefix("", "hi")).toBe("hi");
});

/** A data-only foreground role (a supervisor recovery re-runs it once after a turn limit). */
const PROBE: RoleDefinition = {
  name: "prefix-probe",
  whenToUse: "test only",
  background: false,
  limits: { maxAsk: 3 },
  sideEffects: "none",
  capabilities: ["read"],
  model: HAIKU_MODEL,
  budgetUsd: 0.4,
  promptSections: () => ["probe contract"],
};

/** Run PROBE once (fresh thread, one titled thread in its channel); the fake query records each prompt + resume id. */
async function runProbe(results: Record<string, unknown>[]) {
  const env = makeEnv();
  saveTitle(env.db, "thA", "Fix invoice export", "", Date.now(), "c1", "main");
  const roles = ROLES as Record<string, RoleDefinition>;
  roles[PROBE.name] = PROBE;
  const calls: { prompt: string; resume?: string }[] = [];
  try {
    insertTurn(env.db, {
      id: "t1",
      threadId: "th",
      source: "t",
      location: "location",
      role: PROBE.name,
    });
    await runRole(
      {
        db: env.db,
        config: env.config,
        approvals: stubGateway(),
        queryFn: ((a: any) => {
          calls.push({ prompt: String(a.prompt), resume: a.options.resume });
          return fakeQuery([resultMsg(results[calls.length - 1] ?? {})])(a);
        }) as never,
      },
      {
        turnId: "t1",
        threadId: "th",
        text: "hard question",
        role: PROBE.name,
        workspace: "main",
        channelId: "c1",
        locations: [{ name: "location", path: env.location } as never],
        ac: new AbortController(),
      },
    );
  } finally {
    delete roles[PROBE.name];
  }
  return calls;
}

test("a recovery re-run that resumes the first session gets no second prefix", async () => {
  const calls = await runProbe([
    { subtype: "error_max_turns", is_error: false, result: undefined, session_id: "s0" },
    { result: "done", session_id: "s0" },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.prompt).toContain(DIGEST_HEADING);
  expect(calls[1]).toEqual({ prompt: "hard question", resume: "s0" });
});
