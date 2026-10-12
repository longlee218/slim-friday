import { expect, test } from "bun:test";
import { workspacePaths } from "../src/config/workspace-paths";
import { ATTACHMENT_PATH_PREFIX } from "../src/ingress/attachment-text";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentClassifier, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { CONFIRM_TASK_QUESTION } from "../src/orchestrator/dispatch/queued-tasks";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeRepo } from "./git-fixture";
import {
  addRepo,
  answering,
  clearWorkspaces,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

// Discussion guard: L3 alone picks a NEW dev task right after an assistant turn -> ONE yes/no question first.
// yes -> the task opens; no -> the assistant answers the original message.

/** Env with a workspace clone of a repo. */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
  return env;
}

/** Fake L3: answers `dev/new/high`, and records the inputs it saw. */
function engine(role = "dev") {
  const inputs: Parameters<IntentClassifier["classify"]>[0][] = [];
  const classifier: IntentClassifier = {
    classify: async (i) => {
      inputs.push(i);
      return answering({
        role,
        scope: "new",
        confidence: "high",
        reason: "r",
      } satisfies IntentResult)(i);
    },
  };
  return { classifier, inputs };
}

/** The dev run asks to approve its plan and stops (the owner never answers); every other run is an assistant answer. */
function fakeSdk(seen: any[]) {
  return (a: any) => {
    seen.push(a);
    return (async function* () {
      if (a.options.permissionMode === "bypassPermissions") {
        await a.options.canUseTool(
          ASK_USER_QUESTION_TOOL_NAME,
          { questions: [{ question: "Approve the plan?", options: [{ label: "Approve" }] }] },
          {},
        );
        yield resultMsg({ result: "plan approved" });
        return;
      }
      yield resultMsg({ result: "assistant answer", session_id: "sess-qa" });
    })();
  };
}

async function build() {
  const env = await setup();
  const e = engine();
  const seen: any[] = [];
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({
      confirm: async () => ({ approved: false, reason: "no" }),
      askChoice: async (a) => a.options[0],
    }),
    queryFn: fakeSdk(seen) as never,
    intent: {
      pipeline: {
        lexicon: loadLexicon(env.home),
        tagRouter: createRoleTagRouter(Object.values(ROLES)),
      },
      classifier: e.classifier,
    } satisfies IntentDeps,
  });
  const msg = (text: string) => ({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text,
  });
  const q = (sql: string) => env.db.query(sql).all() as any[];
  return { env, e, seen, handle, msg, q };
}

const PROPOSAL = "Tôi đề xuất xây dựng một lớp cache cho bảng giá, bạn thấy sao?";

test("dev/new from L3 alone after an assistant turn asks first; yes opens the task", async () => {
  const { e, seen, handle, msg, q } = await build();
  await handle(msg("[ask] explain the repo")); // assistant turn (L1 tag)
  expect(await handle(msg(PROPOSAL))).toBe(CONFIRM_TASK_QUESTION);
  expect(e.inputs).toHaveLength(1);
  expect(e.inputs[0]?.thread.lastTurn).toEqual({ role: "assistant" });
  expect(q("SELECT role FROM turns")).toEqual([{ role: "assistant" }]); // nothing opened yet
  expect(q("SELECT status, reason FROM proposals")).toEqual([
    { status: "pending", reason: "confirm_task" },
  ]);
  const reply = await handle(msg("yes"));
  expect(reply).toContain("Starting dev");
  expect(seen.some((s) => s.options.permissionMode === "bypassPermissions")).toBe(true);
  expect(q("SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
});

test("no -> the assistant answers the original message (no dev task)", async () => {
  const { seen, handle, msg, q } = await build();
  await handle(msg("[ask] explain the repo"));
  await handle(msg(PROPOSAL));
  expect(await handle(msg("no"))).toBe("assistant answer");
  expect(seen.at(-1).prompt).toContain(PROPOSAL);
  expect(q("SELECT role FROM turns")).toEqual([{ role: "assistant" }, { role: "assistant" }]);
  expect(q("SELECT status FROM proposals")).toEqual([{ status: "refused" }]);
});

test("no guard: a first message, a [dev] tag or a role other than a staged one is unaffected", async () => {
  const { handle, msg, q } = await build();
  expect(await handle(msg("please add b.txt"))).toContain("Starting dev"); // idle thread, no earlier turn
  const second = await build();
  await second.handle(second.msg("[ask] explain the repo"));
  expect(await second.handle(second.msg("[dev] add b.txt"))).toContain("Starting dev");
  expect(q("SELECT role FROM turns")).toEqual([{ role: "dev" }]);
});

test("the saved-copy path of a long attachment reaches the assistant, never the dev task brief", async () => {
  const { seen, handle, msg, q } = await build();
  const withPath = `${PROPOSAL}\n\n${ATTACHMENT_PATH_PREFIX}/home/x/tmp/attachments/th1/1-r.md`;
  await handle(msg("[ask] explain the repo"));
  await handle(msg(withPath));
  await handle(msg("yes"));
  expect(q("SELECT brief FROM turns WHERE role = 'dev'")[0].brief).not.toContain("/home/x/tmp");
  expect(q("SELECT brief FROM proposals")[0].brief).toContain("/home/x/tmp"); // kept for a later 'no'
  expect(seen.length).toBeGreaterThan(1);
});

test("a dev brief carries the recent conversation (capped, data); a declined task answers the original message only", async () => {
  const { seen, handle, msg, q } = await build();
  await handle(msg("[ask] explain the repo"));
  const recent = [
    { from: "owner" as const, text: "what about caching?" },
    {
      from: "bot" as const,
      text: "Option B: cache prices for 5 minutes. token=sk-ant-abcdefghijklmnop123456",
    },
  ];
  await handle({ ...msg("làm cái đó đi"), recent });
  const brief = q("SELECT brief FROM proposals")[0].brief as string;
  expect(brief.startsWith("làm cái đó đi")).toBe(true);
  expect(brief).toContain("Recent conversation (data):");
  expect(brief).toContain("- bot: Option B: cache prices for 5 minutes.");
  expect(brief).not.toContain("sk-ant-abcdefghijklmnop123456"); // redacted
  expect(brief.length).toBeLessThan(1500);
  expect(await handle(msg("no"))).toBe("assistant answer");
  expect(seen.at(-1).prompt).toContain("làm cái đó đi");
  expect(seen.at(-1).prompt).not.toContain("Recent conversation");
});
