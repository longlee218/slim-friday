import type { TaskClass } from "../src/config/model-routing";
import type { ThreadState } from "../src/orchestrator/thread/thread-state";
import { CLASS_CASES } from "./intent-eval-cases-class";
import { DISCUSSION_CASES } from "./intent-eval-cases-discussion";
import { IDLE_CASES } from "./intent-eval-cases-idle";

/* Golden cases of the intent layer (data only; the runner is intent-eval.live.test.ts). */

/** What the thread looks like when the message arrives. */
export interface ThreadFacts {
  state: ThreadState;
  activeRole?: string;
  activeStage?: string;
  gate?: "plan-approval" | "delivery";
  /** One line per earlier task (the classifier sees the last 3). */
  ledger?: string[];
  /** The thread has a task or a live clone (scope `active` is possible). Default: state is not idle/done. */
  hasTask?: boolean;
  /** Role and last stage of the thread's previous turn (L4 input `lastTurn`). */
  lastTurn?: { role: string; kind: string };
}

/** What the layer must decide. A missing field is not scored. `ask` = low confidence (the owner is asked). */
export interface Expected {
  role?: "assistant" | "dev";
  scope?: "active" | "new";
  cls?: TaskClass;
  ask?: true;
  /** Injection-style text: any registry role or an owner question passes (never a crash / unknown role). */
  anyRegistryRoleOrAsk?: true;
}

/** One golden case. `codeRequest` = a clear change request: while idle it must NEVER reach a non-dev role. */
export interface GoldenCase {
  text: string;
  thread: ThreadFacts;
  expect: Expected;
  codeRequest?: true;
  /** `holdout` = never used to tune the prompt; scored and reported apart. */
  group?: "holdout";
}

const LEDGER = ["dev: add isEmail helper to src/utils.ts (done, 1 commit)"];
const PLAN: ThreadFacts = {
  state: "awaiting_plan_approval",
  activeRole: "dev",
  activeStage: "plan",
  gate: "plan-approval",
  ledger: ["dev: round formatPrice to 2 decimals (plan waiting)"],
};
const RUNNING: ThreadFacts = {
  state: "running",
  activeRole: "dev",
  activeStage: "exec",
  ledger: ["dev: round formatPrice to 2 decimals (running)"],
};
const RESULT: ThreadFacts = {
  state: "awaiting_result",
  activeRole: "dev",
  activeStage: "exec",
  gate: "delivery",
  ledger: ["dev: round formatPrice to 2 decimals (result waits for the owner)"],
};
const DONE_CLONE: ThreadFacts = { state: "done", ledger: LEDGER, hasTask: true };

export const GOLDEN: GoldenCase[] = [
  ...IDLE_CASES,
  ...CLASS_CASES,
  ...DISCUSSION_CASES,
  // Plan gate: feedback on the plan is dev/active; a question is the assistant; a separate request is new.
  {
    text: "Please also handle the null case in the plan.",
    thread: PLAN,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "Thêm bước viết test vào kế hoạch đi.",
    thread: PLAN,
    expect: { role: "dev", scope: "active" },
  },
  { text: "What does the plan mean by 'repo: shop'?", thread: PLAN, expect: { role: "assistant" } },
  {
    text: "New request, unrelated to this plan: add a LICENSE file to the repo.",
    thread: PLAN,
    expect: { role: "dev", scope: "new" },
  },
  // Running: steer (dev/active), side question (assistant), queued request (dev/new).
  {
    text: "Also make it work for negative prices.",
    thread: RUNNING,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "Chờ đã, đừng xử lý ngoại lệ nữa, chỉ cần log thôi.",
    thread: RUNNING,
    expect: { role: "dev", scope: "active" },
  },
  {
    text: "While that runs: where is slug defined?",
    thread: RUNNING,
    expect: { role: "assistant" },
  },
  {
    text: "After this one, rename slug to toSlug everywhere.",
    thread: RUNNING,
    expect: { role: "dev", scope: "new" },
  },
  // Result waiting: fix loop (dev/active), questions (assistant), next task (dev/new).
  {
    text: "It still rounds 0.005 the wrong way, fix it.",
    thread: RESULT,
    expect: { role: "dev", scope: "active", cls: "standard" },
  },
  {
    text: "Thanks. Explain what you changed in two lines.",
    thread: RESULT,
    expect: { role: "assistant" },
  },
  { text: "Cho mình hỏi file nào bị sửa vậy?", thread: RESULT, expect: { role: "assistant" } },
  { text: "Why did the test fail in CI?", thread: RESULT, expect: { role: "assistant" } },
  {
    text: "Next task: add pagination to listOrders in src/orders.ts.",
    thread: RESULT,
    expect: { role: "dev", scope: "new" },
  },
  // Done with a live clone: a follow-up on the same work is active.
  {
    text: "Also handle the empty string there.",
    thread: DONE_CLONE,
    expect: { role: "dev", scope: "active" },
  },
];
