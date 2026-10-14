import { expect, test } from "bun:test";
import { ATTACHMENT_PATH_PREFIX } from "../src/ingress/attachment-text";
import type { IntentDeps } from "../src/intent/decide-intent";
import type { IntentClassifier, IntentResult } from "../src/intent/intent-types";
import { loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { ROLES } from "../src/roles/role-registry";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  answering,
  clearWorkspaces,
  defaultLocationPath,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

// Discussion guard: L3 alone picks a NEW dev task right after an assistant turn -> ONE yes/no question first.
// yes -> the task opens; no -> the assistant answers the original message.

/** Env with a workspace clone of a location. */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "Test User <test@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
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
    language: "en" as const,
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text,
  });
  const q = (sql: string) => env.db.query(sql).all() as any[];
  return { env, e, seen, handle, msg, q };
}

const PROPOSAL = "Tôi đề xuất xây dựng một lớp cache cho bảng giá, bạn thấy sao?";

test("dev/new from L3 alone after an assistant turn starts the task at once (no confirmation)", async () => {
  const { e, seen, handle, msg, q } = await build();
  await handle(msg("[ask] explain the location")); // assistant turn (L1 tag)
  expect(await handle(msg(PROPOSAL))).toContain("starting on your request");
  expect(e.inputs).toHaveLength(1);
  expect(e.inputs[0]?.thread.lastTurn).toEqual({ role: "assistant" });
  expect(q("SELECT role FROM turns")).toEqual([{ role: "assistant" }, { role: "dev" }]);
  expect(seen.some((s) => s.options.permissionMode === "bypassPermissions")).toBe(true);
  expect(q("SELECT status FROM proposals")).toEqual([{ status: "dispatched" }]);
});

test("no guard: a first message, a [dev] tag or a role other than a staged one is unaffected", async () => {
  const { handle, msg, q } = await build();
  expect(await handle(msg("please add b.txt"))).toContain("starting on your request"); // idle thread, no earlier turn
  const second = await build();
  await second.handle(second.msg("[ask] explain the location"));
  expect(await second.handle(second.msg("[dev] add b.txt"))).toContain("starting on your request");
  expect(q("SELECT role FROM turns")).toEqual([{ role: "dev" }]);
});

test("the saved-copy path of a long attachment reaches the assistant, never the dev task brief", async () => {
  const { seen, handle, msg, q } = await build();
  const withPath = `${PROPOSAL}\n\n${ATTACHMENT_PATH_PREFIX}/home/x/tmp/attachments/th1/1-r.md`;
  await handle(msg("[ask] explain the location"));
  await handle(msg(withPath));
  expect(q("SELECT brief FROM turns WHERE role = 'dev'")[0].brief).not.toContain("/home/x/tmp");
  expect(seen.length).toBeGreaterThan(1);
});

test("a dev brief is the owner text only (the recent conversation goes to the system context)", async () => {
  const { handle, msg, q } = await build();
  await handle(msg("[ask] explain the location"));
  const recent = [
    { from: "owner" as const, text: "what about caching?" },
    {
      from: "bot" as const,
      text: "Option B: cache prices for 5 minutes. token=sk-ant-abcdefghijklmnop123456",
    },
  ];
  await handle({ ...msg("làm cái đó đi"), recent });
  const brief = q("SELECT brief FROM proposals")[0].brief as string;
  expect(brief).toBe("làm cái đó đi");
});
