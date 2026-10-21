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
import { saveSummary } from "../src/storage/thread-summary-store";
import { fakeQuery, makeEnv, resultMsg, stubGateway } from "./helpers";

/** A run input with only what the prefix reads. */
const input = (over: Partial<RoleRunInput> = {}): RoleRunInput =>
  ({
    threadId: "th",
    channelId: "c1",
    ...over,
  }) as RoleRunInput;

/** A db with one titled thread in channel c1. */
function seeded() {
  const db = openDb(":memory:");
  saveTitle(db, "other", "Earlier topic", "", 1, "c1", "main");
  return db;
}

test("a fresh session gets the channel digest, nothing else (no thread seed even for a thread with a summary)", () => {
  const db = seeded();
  saveSummary(db, "th", "main", "SUM");
  const p = firstPromptPrefix(db, input());
  expect(p.startsWith(DIGEST_HEADING)).toBe(true);
  expect(p).toContain("Earlier topic");
  expect(p).not.toContain("SUM");
});

test("channel mode: absent = task (digest), task = digest, chat = none", () => {
  const db = seeded();
  expect(firstPromptPrefix(db, input())).toContain("Earlier topic");
  expect(firstPromptPrefix(db, input({ channelMode: "task" }))).toContain("Earlier topic");
  expect(firstPromptPrefix(db, input({ channelMode: "chat" }))).toBe("");
});

test("withPrefix labels the owner text after the DATA blocks; no prefix = the text alone", () => {
  expect(withPrefix("DATA", "hi")).toBe(`DATA\n\n${OWNER_MESSAGE_LABEL}\nhi`);
  expect(withPrefix("", "hi")).toBe("hi");
});

/** A data-only foreground role (a supervisor recovery re-runs it once after a turn limit). */
const PROBE: RoleDefinition = {
  name: "prefix-probe",
  whenToUse: "test only",
  kind: "lead",
  limits: { maxAsk: 3, maxTurns: 20 },
  subagents: { parallel: 3, depth: 1 },
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
  // The supervisor's note heads the re-run prompt (a resumed session keeps its first system prompt); no digest again.
  expect(calls[1]?.resume).toBe("s0");
  expect(calls[1]?.prompt).toStartWith("Internal note (not from the owner): the previous attempt");
  expect(calls[1]?.prompt).toEndWith("\n\nhard question");
  expect(calls[1]?.prompt).not.toContain(DIGEST_HEADING);
});
